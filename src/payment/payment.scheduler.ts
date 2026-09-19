import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { MellatPaymentService } from './services/mellat-payment.service';
import { TaraPaymentService } from './services/tara-payment.service';
import { ZarinpalPaymentService } from './services/zarinpal-payment.service';

@Injectable()
export class PaymentScheduler {
  private readonly logger = new Logger(PaymentScheduler.name);

  private running = false;

  constructor(
    private readonly mellatService: MellatPaymentService,
    private readonly taraService: TaraPaymentService,
    private readonly zarinpalService: ZarinpalPaymentService,
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
    }

    try {
      await this.zarinpalService.reconcilePendingPayments();
    } catch (error) {
      this.logger.error(
        '❌ همسان‌سازی پرداخت‌های زرین‌پال خطا خورد.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
