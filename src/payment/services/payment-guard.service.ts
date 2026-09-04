import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { In, Repository } from 'typeorm';

import { Payment, PaymentStatus } from '../entities/payment.entity';

/**
 * پیش‌شرط‌های مشترک شروع پرداخت برای همه درگاه‌ها.
 *
 * ۱. سفارش باید در وضعیت PENDING باشد
 *    (نمی‌گذاریم برای سفارش لغو‌شده/پرداخت‌شده پول گرفته شود)
 *
 * ۲. اگر پرداخت موفق (SUCCESS) یا تأییدشده ولی در حال واریز (VERIFIED)
 *    برای سفارش وجود داشته باشد، درخواست پرداخت جدید رد می‌شود؛
 *    وگرنه امکان دارد از مشتری دو بار پول گرفته شود.
 *
 * ۳. درخواست پرداخت‌های بازی (PENDING) قبلی برای این سفارش باطل می‌شوند
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
  ) {}

  async ensureOrderPayable(order: Order): Promise<void> {
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException(
        `این سفارش قابل پرداخت نیست (وضعیت فعلی: ${order.status})`,
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
