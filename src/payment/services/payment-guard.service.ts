import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClubService } from 'src/club/club.service';
import { FirstPurchaseGiftService } from 'src/first-purchase-gift/first-purchase-gift.service';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
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
}
