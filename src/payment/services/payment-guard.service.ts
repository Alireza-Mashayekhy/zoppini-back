import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClubService } from 'src/club/club.service';
import { FirstPurchaseGiftService } from 'src/first-purchase-gift/first-purchase-gift.service';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import {
  RahkaranStockService,
  STOCK_ERROR_CODES,
  unavailableMessage,
} from 'src/rahkaran/rahkaran-stock.service';
import { In, Repository } from 'typeorm';

import { Payment, PaymentStatus } from '../entities/payment.entity';
import { PromotionRevalidationService } from './promotion-revalidation.service';

/**
 * پیش‌شرط‌های مشترک شروع پرداخت برای همه درگاه‌ها.
 *
 * ۱. سفارش باید در وضعیت PENDING باشد
 *    (نمی‌گذاریم برای سفارش لغو‌شده/پرداخت‌شده پول گرفته شود)
 *
 * ۲. درخواست پرداخت‌های بازی (PENDING) قبلی برای این سفارش باطل می‌شوند
 *    تا هم کاربرِ برگشته از درگاه بتواند دوباره پرداخت کند و هم
 *    امکان پرداخت همزمان با دو درگاه (پرداخت دوگانه) از بین برود.
 *    اگر کاربر واقعاً یکی از آن‌ها را پرداخته باشد، در callback همان
 *    پرداخت با درخواست verify به درگاه، همچنان تأیید و نهایی می‌شود.
 *
 * ۳. موجودی همهٔ اقلام سفارش درست پیش از انتقال به درگاه دوباره از
 *    راهکاران بررسی می‌شود (همهٔ درگاه‌ها از همین متد عبور می‌کنند).
 */
@Injectable()
export class PaymentGuardService {
  private readonly logger = new Logger(PaymentGuardService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,

    private readonly promotionsRevalidation: PromotionRevalidationService,

    @Optional() private readonly clubService?: ClubService,

    @Optional()
    private readonly firstPurchaseGiftService?: FirstPurchaseGiftService,

    /**
     * عمداً بدون @Optional: در اپ واقعی DI الزامی است. اگر در ساخت دستی
     * داده نشود، شروع پرداخت «Fail closed» می‌شود.
     */
    @Inject(forwardRef(() => RahkaranStockService))
    private readonly rahkaranStockService?: RahkaranStockService,
  ) {}

  async ensureOrderPayable(order: Order): Promise<void> {
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException(
        `این سفارش قابل پرداخت نیست (وضعیت فعلی: ${order.status})`,
      );
    }

    // پروموشن‌ها پیش از گرفتن پول دوباره اعتبارسنجی می‌شوند؛ اگر تغییر
    // کرده باشند، پرداخت با پیام شفاف متوقف می‌شود تا مشتری مبلغ جدید را
    // ببیند و دوباره تأیید کند.
    await this.promotionsRevalidation.assertPayable(order);

    if (Number(order.firstPurchaseGiftDiscount ?? 0) > 0) {
      if (!this.firstPurchaseGiftService || !order.user?.id) {
        throw new BadRequestException('اعتبار هدیهٔ خرید اول قابل بررسی نیست.');
      }
      await this.firstPurchaseGiftService.assertClaimPayable(
        order.user.id,
        order.id,
      );
    }

    const clubCreditPayment = Number(order.clubCreditPayment ?? 0);
    if (clubCreditPayment > 0 && this.clubService) {
      const customerCode = order.user?.phone;
      if (!customerCode) {
        throw new BadRequestException(
          'شماره موبایل سفارش برای بررسی اعتبار باشگاه موجود نیست.',
        );
      }
      const customer = await this.clubService.getCustomer(customerCode);
      if (Number(customer.AvailableCredit ?? 0) < clubCreditPayment * 10) {
        throw new BadRequestException(
          'اعتبار باشگاه دایاتک تغییر کرده است؛ لطفاً سفارش را دوباره ثبت کنید.',
        );
      }
    }

    const finalPrice = Number(order.finalPrice ?? 0);
    const externalPayment =
      Number(order.walletPayment ?? 0) + Number(order.clubCreditPayment ?? 0);

    if (finalPrice > 0 && externalPayment >= finalPrice) {
      throw new BadRequestException(
        'کل مبلغ سفارش با اعتبارهای انتخاب‌شده پرداخت می‌شود و نیازی به درگاه نیست',
      );
    }

    const openPayments = await this.paymentRepo.find({
      where: {
        orderId: order.id,
        status: In([
          PaymentStatus.PENDING,
          PaymentStatus.VERIFIED,
          PaymentStatus.SUCCESS,
        ]),
      },
    });

    if (!openPayments.length) {
      await this.assertStockBeforeGateway(order);
      return;
    }

    const confirmed = openPayments.find(
      payment =>
        payment.status === PaymentStatus.SUCCESS ||
        payment.status === PaymentStatus.VERIFIED,
    );

    if (confirmed) {
      this.logger.error(
        `❌ سفارش ${order.id} پرداخت ${confirmed.status} دارد ` +
          `(پرداخت ${confirmed.id} از درگاه ${confirmed.gateway}) ولی وضعیت سفارش PENDING است. ` +
          'درخواست پرداخت جدید رد شد تا پرداخت دوگانه رخ ندهد.',
      );

      throw new BadRequestException(
        confirmed.status === PaymentStatus.SUCCESS
          ? 'پرداخت این سفارش پیش‌تر انجام شده است'
          : 'پرداخت این سفارش تأیید شده و در حال نهایی‌سازی است؛ لطفاً دوباره پرداخت نکنید',
      );
    }

    await this.assertStockBeforeGateway(order);

    const pendingPayments = openPayments;

    for (const payment of pendingPayments) {
      payment.status = PaymentStatus.FAILED;
      payment.resCode = 'STALE';
      await this.paymentRepo.save(payment);

      this.logger.warn(
        `پرداخت ${payment.id} (درگاه ${payment.gateway}) برای سفارش ${order.id}` +
          ` به‌عنوان درخواست قدیمی باطل شد (STALE).`,
      );
    }
  }

  /**
   * بررسی موجودی همهٔ اقلام از راهکاران پیش از ساخت درخواست پرداخت.
   * ناکافی → 409 با فهرست کالا/تنوع/تعداد موجود؛ عدم دسترسی → 503.
   */
  private async assertStockBeforeGateway(order: Order): Promise<void> {
    if (!this.rahkaranStockService) {
      this.logger.error(
        `بررسی موجودی برای سفارش ${order.id} ممکن نیست (سرویس موجودی تزریق نشده)؛ شروع پرداخت متوقف شد.`,
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: STOCK_ERROR_CODES.UNAVAILABLE,
        message: unavailableMessage('payment_start'),
      });
    }

    await this.rahkaranStockService.assertCheckoutStock(
      (order.items ?? [])
        .filter(item => item.variant?.id)
        .map(item => ({
          variantId: item.variant!.id,
          quantity: Number(item.quantity),
        })),
      {
        stage: 'payment_start',
        excludeUserId: order.user?.id,
        orderId: order.id,
      },
    );
  }
}
