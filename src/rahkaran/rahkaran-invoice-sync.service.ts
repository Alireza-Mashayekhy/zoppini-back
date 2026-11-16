import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createCorrelationId,
  serializeError,
  structuredLog,
} from 'src/common/logging/structured-logger';
import { Order } from 'src/order/entities/order.entity';
import { OrdersService } from 'src/order/order.service';
import { Repository } from 'typeorm';

import {
  RahkaranInvoiceSync,
  RahkaranInvoiceSyncStatus,
} from './entities/rahkaran-invoice-sync.entity';
import { RahkaranService } from './rahkaran.service';

export interface RahkaranSyncTriggerContext {
  /** منبع تلاش: پرداخت موفق، retry خودکار، یا retry دستی ادمین */
  trigger?: 'payment' | 'scheduler' | 'admin';
  correlationId?: string;
}

export interface RahkaranSyncResult {
  success: boolean;
  /**
   * true یعنی هیچ درخواستی به راهکاران ارسال نشد:
   * یا فاکتور قبلاً ثبت شده، یا تلاش دیگری هم‌اکنون در حال انجام است.
   */
  skipped?: 'already_registered' | 'already_in_progress';
  correlationId: string;
  invoiceId?: number | null;
  invoiceNumber?: string | null;
  attempts?: number;
  error?: string;
}

/** سفارشی که برای ثبت فاکتور در راهکاران ارسال می‌شود. */
export interface RahkaranSyncableOrder {
  id: number;
  orderNumber: string;
  finalPrice: number;
  user: { phone: string };
  items: Array<{
    quantity: number;
    price: number;
    variant: { sku: string | null } | null;
  }>;
}

@Injectable()
export class RahkaranInvoiceSyncService {
  private readonly logger = new Logger(RahkaranInvoiceSyncService.name);

  /**
   * سقف تلاش‌های خودکار؛ بعد از آن رکورد در وضعیت failed می‌ماند و
   * از طریق endpoint مدیریتی قابل retry است.
   */
  static readonly MAX_AUTO_ATTEMPTS = 8;

  /**
   * اگر رکوردی بیش از این مدت در وضعیت processing بماند، فرض می‌کنیم
   * پردازش آن (مثلاً به علت restart سرویس) ناتمام مانده و retry می‌شود.
   */
  static readonly STALE_PROCESSING_MS = 10 * 60 * 1000;

  constructor(
    @InjectRepository(RahkaranInvoiceSync)
    private readonly syncRepo: Repository<RahkaranInvoiceSync>,

    private readonly rahkaranService: RahkaranService,

    @Optional()
    @Inject(forwardRef(() => OrdersService))
    private readonly ordersService?: OrdersService,
  ) {}

  /**
   * ثبت فاکتور سفارش پرداخت‌شده در راهکاران با ردیابی کامل وضعیت.
   *
   * این متد هرگز throw نمی‌کند؛ نتیجه را برمی‌گرداند و همهٔ گام‌ها را
   * با correlationId یکسان لاگ می‌کند. قید یکتایی order_id از ثبت
   * فاکتور تکراری جلوگیری می‌کند.
   */
  async syncPaidOrder(
    order: RahkaranSyncableOrder,
    context?: RahkaranSyncTriggerContext,
  ): Promise<RahkaranSyncResult> {
    const correlationId =
      context?.correlationId ?? createCorrelationId('rah-inv');

    const startedAt = Date.now();

    try {
      const row = await this.ensureTrackingRow(order);

      // ==========================================================
      // Idempotency: فاکتور قبلاً ثبت شده است
      // ==========================================================

      if (row.status === RahkaranInvoiceSyncStatus.SUCCESS) {
        this.logger.log(
          structuredLog('rahkaran.invoice.registration.skipped', {
            correlationId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            trigger: context?.trigger,
            reason: 'already_registered',
            invoiceId: row.invoiceId,
            invoiceNumber: row.invoiceNumber,
          }),
        );

        return {
          success: true,
          skipped: 'already_registered',
          correlationId,
          invoiceId: row.invoiceId,
          invoiceNumber: row.invoiceNumber,
          attempts: row.attempts,
        };
      }

      // ==========================================================
      // Claim: فقط یک تلاش همزمان اجازهٔ ادامه دارد
      // ==========================================================

      const claimed = await this.tryClaimSync(order.id, correlationId);

      if (!claimed) {
        this.logger.warn(
          structuredLog('rahkaran.invoice.registration.skipped', {
            correlationId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            trigger: context?.trigger,
            reason: 'already_in_progress',
          }),
        );

        return {
          success: false,
          skipped: 'already_in_progress',
          correlationId,
          attempts: row.attempts,
        };
      }

      const attempt = row.attempts + 1;

      this.logger.log(
        structuredLog('rahkaran.invoice.registration.start', {
          correlationId,
          orderId: order.id,
          orderNumber: order.orderNumber,
          attempt,
          trigger: context?.trigger ?? 'payment',
          itemsCount: order.items?.length ?? 0,
          finalPriceToman: Number(order.finalPrice),
        }),
      );

      try {
        const invoice = await this.rahkaranService.syncOrderToRahkaran(order, {
          correlationId,
          attempt,
        });

        const invoiceId = invoice?.id ?? invoice?.invoiceId ?? null;
        const invoiceNumber = invoice?.number ?? null;

        /**
         * ذخیرهٔ نتیجهٔ موفقیت جداگانه مدیریت می‌شود:
         *
         * اگر فاکتور در راهکاران ثبت شده ولی این UPDATE خطا بخورد
         * (مثلاً قطعی لحظه‌ای دیتابیس)، رکورد در processing می‌ماند و retry
         * بعدی می‌تواند فاکتور تکراری بسازد. این وضعیت با لاگ بحرانیِ
         * مخصوص مشخص می‌شود تا قبل از retry دستی بررسی شود.
         */
        try {
          await this.syncRepo.update(
            { orderId: order.id },
            {
              status: RahkaranInvoiceSyncStatus.SUCCESS,
              attempts: attempt,
              invoiceId,
              invoiceNumber,
              succeededAt: new Date(),
              lastError: null,
              lastCorrelationId: correlationId,
            },
          );
        } catch (persistError) {
          this.logger.error(
            structuredLog('rahkaran.invoice.registration.persist_error', {
              correlationId,
              orderId: order.id,
              orderNumber: order.orderNumber,
              attempt,
              invoiceId,
              invoiceNumber,
              note: 'invoice_registered_in_rahkaran_but_status_persist_failed — قبل از retry، وجود فاکتور را در راهکاران بررسی کنید.',
              error: serializeError(persistError),
            }),
          );
        }

        this.logger.log(
          structuredLog('rahkaran.invoice.registration.success', {
            correlationId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            attempt,
            trigger: context?.trigger ?? 'payment',
            invoiceId,
            invoiceNumber,
            durationMs: Date.now() - startedAt,
          }),
        );

        return {
          success: true,
          correlationId,
          invoiceId,
          invoiceNumber,
          attempts: attempt,
        };
      } catch (error) {
        const serialized = serializeError(error);

        await this.syncRepo.update(
          { orderId: order.id },
          {
            status: RahkaranInvoiceSyncStatus.FAILED,
            attempts: attempt,
            lastCorrelationId: correlationId,
            lastError: `${serialized.type}: ${serialized.message}`.slice(
              0,
              4000,
            ),
          },
        );

        this.logger.error(
          structuredLog('rahkaran.invoice.registration.failed', {
            correlationId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            attempt,
            trigger: context?.trigger ?? 'payment',
            durationMs: Date.now() - startedAt,
            error: serialized,
          }),
        );

        if (attempt >= RahkaranInvoiceSyncService.MAX_AUTO_ATTEMPTS) {
          this.logger.error(
            structuredLog('rahkaran.invoice.registration.needs_manual_review', {
              correlationId,
              orderId: order.id,
              orderNumber: order.orderNumber,
              attempts: attempt,
              maxAutoAttempts: RahkaranInvoiceSyncService.MAX_AUTO_ATTEMPTS,
              lastError: serialized.message,
            }),
          );
        }

        return {
          success: false,
          correlationId,
          attempts: attempt,
          error: serialized.message,
        };
      }
    } catch (error) {
      // خطای خودِ لایهٔ ردیابی (دیتابیس و...) — هرگز به فراخوان‌دهنده
      // (فرآیند پرداخت) منتقل نمی‌شود.
      this.logger.error(
        structuredLog('rahkaran.invoice.registration.tracking_error', {
          correlationId,
          orderId: order?.id,
          orderNumber: order?.orderNumber,
          trigger: context?.trigger,
          error: serializeError(error),
        }),
      );

      return {
        success: false,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * رکوردهای نیازمند retry خودکار:
   * - failed با کمتر از حداکثر تلاش
   * - processing قدیمی (تلاش ناتمام/کرش)
   * - pending رها شده
   */
  async findRetryableSyncs(limit = 20): Promise<RahkaranInvoiceSync[]> {
    const staleCutoff = new Date(
      Date.now() - RahkaranInvoiceSyncService.STALE_PROCESSING_MS,
    );

    return this.syncRepo
      .createQueryBuilder('sync')
      .where('sync.status = :pending', {
        pending: RahkaranInvoiceSyncStatus.PENDING,
      })
      .orWhere('sync.status = :failed AND sync.attempts < :maxAttempts', {
        failed: RahkaranInvoiceSyncStatus.FAILED,
        maxAttempts: RahkaranInvoiceSyncService.MAX_AUTO_ATTEMPTS,
      })
      .orWhere(
        'sync.status = :processing AND (sync.last_attempt_at IS NULL OR sync.last_attempt_at < :staleCutoff)',
        {
          processing: RahkaranInvoiceSyncStatus.PROCESSING,
          staleCutoff,
        },
      )
      .orderBy('sync.updatedAt', 'ASC')
      .take(limit)
      .getMany();
  }

  /**
   * retry خودکار رکوردهای ناموفق؛ توسط scheduler صدا زده می‌شود.
   */
  async retryFailedSyncs(limit = 20): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
  }> {
    const retryables = await this.findRetryableSyncs(limit);

    if (!retryables.length) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    let succeeded = 0;
    let failed = 0;

    for (const row of retryables) {
      try {
        const order = await this.loadOrderForSync(row.orderId);

        const result = await this.syncPaidOrder(order, {
          trigger: 'scheduler',
        });

        if (result.success) {
          succeeded += 1;
        } else if (result.skipped) {
          // درخواستی ارسال نشده؛ نه موفق و نه ناموفق شمرده می‌شود.
        } else {
          failed += 1;
        }
      } catch (error) {
        failed += 1;

        this.logger.error(
          structuredLog('rahkaran.invoice.registration.retry_error', {
            correlationId: row.lastCorrelationId ?? undefined,
            orderId: row.orderId,
            orderNumber: row.orderNumber,
            trigger: 'scheduler',
            error: serializeError(error),
          }),
        );
      }
    }

    this.logger.log(
      structuredLog('rahkaran.invoice.registration.retry_summary', {
        processed: retryables.length,
        succeeded,
        failed,
      }),
    );

    return { processed: retryables.length, succeeded, failed };
  }

  /**
   * retry دستی از پنل مدیریت؛ سقف تلاش خودکار را دور می‌زند ولی
   * باز هم از ثبت تکراری (status=success) جلوگیری می‌کند.
   */
  async retryOrderSync(orderId: number): Promise<RahkaranSyncResult> {
    const order = await this.loadOrderForSync(orderId);

    return this.syncPaidOrder(order, { trigger: 'admin' });
  }

  /** وضعیت ثبت فاکتور راهکاران یک سفارش برای پنل مدیریت. */
  async getOrderSyncStatus(
    orderId: number,
  ): Promise<RahkaranInvoiceSync | null> {
    return this.syncRepo.findOne({ where: { orderId } });
  }

  /** فهرست ثبت‌های ناموفق/ناتمام برای پنل مدیریت. */
  async getFailedSyncs(limit = 100): Promise<RahkaranInvoiceSync[]> {
    return this.syncRepo.find({
      where: [
        { status: RahkaranInvoiceSyncStatus.FAILED },
        { status: RahkaranInvoiceSyncStatus.PROCESSING },
      ],
      order: { updatedAt: 'DESC' },
      take: limit,
    });
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async loadOrderForSync(orderId: number): Promise<Order> {
    if (!this.ordersService) {
      throw new BadRequestException(
        'سرویس سفارش برای بازیابی سفارش در دسترس نیست.',
      );
    }

    return this.ordersService.findOne(orderId);
  }

  /**
   * رکورد ردیابی سفارش را (در صورت نبود) ایجاد می‌کند. قید یکتایی
   * order_id از ساخت رکورد تکراری در Race جلوگیری می‌کند.
   */
  private async ensureTrackingRow(
    order: RahkaranSyncableOrder,
  ): Promise<RahkaranInvoiceSync> {
    const existing = await this.syncRepo.findOne({
      where: { orderId: order.id },
    });

    if (existing) {
      return existing;
    }

    try {
      const created = this.syncRepo.create({
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: RahkaranInvoiceSyncStatus.PENDING,
      });

      return await this.syncRepo.save(created);
    } catch (error) {
      // Race: فرآیند دیگری همزمان رکورد را ساخته است.
      const duplicate =
        (error as { code?: string; errno?: number })?.code === 'ER_DUP_ENTRY' ||
        (error as { errno?: number })?.errno === 1062;

      if (duplicate) {
        const row = await this.syncRepo.findOne({
          where: { orderId: order.id },
        });

        if (row) {
          return row;
        }
      }

      throw error;
    }
  }

  /**
   * تغییر اتمیک وضعیت به processing.
   *
   * فقط وقتی موفق می‌شود که تلاش دیگری روی همین سفارش در حال انجام
   * نباشد (یا تلاش قبلی ناتمام/قدیمی مانده باشد). چون UPDATE شرط‌دار
   * یک کوئری واحد است، در برابر Race امن است.
   */
  private async tryClaimSync(
    orderId: number,
    correlationId: string,
  ): Promise<boolean> {
    const staleCutoff = new Date(
      Date.now() - RahkaranInvoiceSyncService.STALE_PROCESSING_MS,
    );

    const result = await this.syncRepo
      .createQueryBuilder()
      .update(RahkaranInvoiceSync)
      .set({
        status: RahkaranInvoiceSyncStatus.PROCESSING,
        lastAttemptAt: new Date(),
        lastCorrelationId: correlationId,
      })
      .where('order_id = :orderId', { orderId })
      .andWhere('status != :success', {
        success: RahkaranInvoiceSyncStatus.SUCCESS,
      })
      .andWhere(
        '(status != :processing OR last_attempt_at IS NULL OR last_attempt_at < :staleCutoff)',
        {
          processing: RahkaranInvoiceSyncStatus.PROCESSING,
          staleCutoff,
        },
      )
      .execute();

    return (result.affected ?? 0) > 0;
  }
}
