import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { Repository } from 'typeorm';

import { Payment, PaymentStatus } from '../entities/payment.entity';

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
  ) {}

  async ensureOrderPayable(order: Order): Promise<void> {
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException(
        `این سفارش قابل پرداخت نیست (وضعیت فعلی: ${order.status})`,
      );
    }

    const pendingPayments = await this.paymentRepo.find({
      where: {
        orderId: order.id,
        status: PaymentStatus.PENDING,
      },
    });

    if (!pendingPayments.length) {
      return;
    }

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
