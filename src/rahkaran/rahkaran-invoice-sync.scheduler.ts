import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { structuredLog } from 'src/common/logging/structured-logger';

import { RahkaranInvoiceSyncService } from './rahkaran-invoice-sync.service';

/**
 * Retry خودکار فاکتورهایی که ثبتشان در راهکاران ناموفق مانده است.
 *
 * پرداخت موفق سفارش از این مسیر جداست: اگر ثبت فاکتور راهکاران خطا بخورد
 * (قطعی شبکه، پاسخ نامعتبر، Timeout، ...) سفارش PAID می‌ماند و این
 * scheduler هر چند دقیقه رکوردهای failed را دوباره تلاش می‌کند تا
 * فاکتور گمشده‌ای باقی نماند.
 */
@Injectable()
export class RahkaranInvoiceSyncScheduler {
  private readonly logger = new Logger(RahkaranInvoiceSyncScheduler.name);

  private running = false;

  constructor(private readonly syncService: RahkaranInvoiceSyncService) {}

  @Cron('0 */2 * * * *', {
    name: 'rahkaran-invoice-sync-retry',
    timeZone: 'Asia/Tehran',
    waitForCompletion: true,
  })
  async retryFailedInvoiceSyncs(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const result = await this.syncService.retryFailedSyncs();

      // فقط وقتی کاری انجام شده لاگ می‌گیریم تا نویز تکراری ایجاد نشود.
      if (result.processed > 0) {
        this.logger.log(
          structuredLog('rahkaran.invoice.registration.scheduler_run', {
            processed: result.processed,
            succeeded: result.succeeded,
            failed: result.failed,
          }),
        );
      }
    } catch (error) {
      this.logger.error(
        structuredLog('rahkaran.invoice.registration.scheduler_error', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      this.running = false;
    }
  }
}
