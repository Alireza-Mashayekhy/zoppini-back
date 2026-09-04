import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { MellatPaymentService } from './services/mellat-payment.service';
import { TaraPaymentService } from './services/tara-payment.service';

/**
 * همسان‌سازی پرداخت‌های بلاتکلیف.
 *
 * اگر کاربر از درگاه برنگردد (بستن مرورگر، قطعی شبکه) یا callback به هر دلیلی
 * نرسد، رکورد پرداخت PENDING می‌ماند در حالی که ممکن است وجه از کارت مشتری
 * کسر شده باشد. هر دو مستند برای این حالت راهکار دارند:
 *
 * - ملت: bpInquiryRequest (استعلام) و bpReversalRequest (برگشت وجه)، به‌علاوهٔ
 *   مهلت ۲۰ دقیقه‌ای برای ارسال bpVerifyRequest که پس از آن دروازه پرداخت
 *   خودش Autoreversal می‌فرستد.
 * - تارا: مرحلهٔ ۶ فرایند، یعنی purchaseInquiry در صورت بی‌پاسخ بودن verify.
 *
 * این زمان‌بند همان مسیرها را به‌صورت خودکار طی می‌کند تا پرداخت موفقِ
 * فراموش‌شده به سفارش تبدیل شود و تراکنش مرده، بلاتکلیف نماند.
 */
@Injectable()
export class PaymentScheduler {
  private readonly logger = new Logger(PaymentScheduler.name);

  private running = false;

  constructor(
    private readonly mellatService: MellatPaymentService,
    private readonly taraService: TaraPaymentService,
  ) {}

  /** هر ۳ دقیقه */
  @Cron('0 */3 * * * *', {
    name: 'payment-reconciliation',
    timeZone: 'Asia/Tehran',
    waitForCompletion: true,
  })
  async reconcilePendingPayments() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      await this.mellatService.reconcilePendingPayments();
    } catch (error) {
      this.logger.error(
        '❌ همسان‌سازی پرداخت‌های ملت خطا خورد.',
        error instanceof Error ? error.stack : String(error),
      );
    }

    try {
      await this.taraService.reconcilePendingPayments();
    } catch (error) {
      this.logger.error(
        '❌ همسان‌سازی پرداخت‌های تارا خطا خورد.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
