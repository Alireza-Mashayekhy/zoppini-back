import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { DigipayPaymentService } from './services/digipay-payment.service';
import { MellatPaymentService } from './services/mellat-payment.service';
import { SnappayPaymentService } from './services/snappay-payment.service';
import { TaraPaymentService } from './services/tara-payment.service';
import { ZarinpalPaymentService } from './services/zarinpal-payment.service';

@Injectable()
export class PaymentScheduler {
  private readonly logger = new Logger(PaymentScheduler.name);

  private running = false;
  private digipayRunning = false;
  private digipayFulfillmentRunning = false;

  constructor(
    private readonly mellatService: MellatPaymentService,
    private readonly taraService: TaraPaymentService,
    private readonly zarinpalService: ZarinpalPaymentService,
    private readonly digipayService: DigipayPaymentService,
    private readonly snappayService: SnappayPaymentService,
  ) {}

  /** اجرای یک کار همسان‌سازی؛ خطای یک درگاه بقیه را متوقف نمی‌کند. */
  private async runSafely(label: string, task: () => Promise<void>) {
    try {
      await task();
    } catch (error) {
      this.logger.error(
        `❌ همسان‌سازی پرداخت‌های ${label} خطا خورد.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** هر ۳ دقیقه: ملت، تارا، زرین‌پال و اسنپ‌پی */
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
      await this.runSafely('ملت', () =>
        this.mellatService.reconcilePendingPayments(),
      );
      await this.runSafely('تارا', () =>
        this.taraService.reconcilePendingPayments(),
      );
      await this.runSafely('زرین‌پال', () =>
        this.zarinpalService.reconcilePendingPayments(),
      );
      await this.runSafely('اسنپ‌پی', () =>
        this.snappayService.reconcilePendingPayments(),
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * هر دقیقه: فقط پرداخت‌های دیجی‌پی.
   *
   * چرا جدا از کرون ۳ دقیقه‌ای؟ مستند UPG می‌گوید اگر Verify تا ۳ دقیقه پس از
   * پرداخت موفق انجام نشود، تراکنش Auto Reverse می‌شود. با فاصلهٔ ۳ دقیقه‌ای
   * (و cutoff قبلی ۲ دقیقه) ممکن بود verify دیر برسد؛ اینجا cutoff ۳۰ ثانیه و
   * اجرا هر ۱ دقیقه است تا در همان پنجره بمانیم.
   */
  @Cron('*/1 * * * *', {
    name: 'digipay-verification',
    timeZone: 'Asia/Tehran',
    waitForCompletion: true,
  })
  async reconcileDigipayPayments() {
    if (this.digipayRunning) {
      return;
    }

    this.digipayRunning = true;

    try {
      await this.runSafely('دیجی‌پی', () =>
        this.digipayService.reconcilePendingPayments(25, 30_000),
      );
    } finally {
      this.digipayRunning = false;
    }
  }

  /**
   * هر ۵ دقیقه: کارهای پس از پرداخت دیجی‌پی
   * - اعلام تحویل (Delivery Order) برای خریدهای اعتباری/BNPL که سفارششان تحویل شده
   * - عودت خودکار وجه سفارش‌های لغوشده
   * - استعلام درخواست‌های عودت معلق (Refund Inquiry)
   */
  @Cron('0 */5 * * * *', {
    name: 'digipay-fulfillment',
    timeZone: 'Asia/Tehran',
    waitForCompletion: true,
  })
  async reconcileDigipayFulfillment() {
    if (this.digipayFulfillmentRunning) {
      return;
    }

    this.digipayFulfillmentRunning = true;

    try {
      await this.runSafely('اعلام تحویل دیجی‌پی', () =>
        this.digipayService.reconcileDeliveries(),
      );
      await this.runSafely('عودت دیجی‌پی', () =>
        this.digipayService.reconcileRefunds(),
      );
    } finally {
      this.digipayFulfillmentRunning = false;
    }
  }
}
