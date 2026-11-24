import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * وضعیت ثبت فاکتور یک سفارش در راهکاران.
 *
 * - pending:   در صف ثبت است (هنوز تلاشی انجام نشده)
 * - processing: یک تلاش در حال انجام است
 * - success:   فاکتور با موفقیت در راهکاران ثبت شده
 * - failed:    آخرین تلاش ناموفق بوده و برای retry مجدد آماده است
 */
export enum RahkaranInvoiceSyncStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SUCCESS = 'success',
  FAILED = 'failed',
}

/**
 * ردیابی وضعیت ثبت فاکتور هر سفارش پرداخت‌شده در راهکاران.
 *
 * چرا این جدول لازم است؟
 * ثبت فاکتور بعد از commit تراکنش سفارش انجام می‌شود و خطای آن نباید
 * پرداخت موفق را برگرداند. بدون این جدول، خطا فقط در لاگ می‌ماند و
 * سفارش‌هایی که فاکتورشان در راهکاران ثبت نشده قابل شناسایی/بازیابی
 * نیستند (همان مشکل «ثبت نشدن گاه‌به‌گاه فاکتورها»).
 *
 * قید یکتایی `order_id` تضمین می‌کند برای هر سفارش حداکثر یک رکورد
 * (و در نتیجه حداکثر یک فاکتور راهکاران) وجود دارد و retry باعث
 * ثبت تکراری نمی‌شود.
 */
@Entity('rahkaran_invoice_sync')
@Index('UQ_rahkaran_invoice_sync_order', ['orderId'], { unique: true })
@Index('IDX_rahkaran_invoice_sync_status', ['status', 'attempts'])
export class RahkaranInvoiceSync {
  @PrimaryGeneratedColumn()
  id: number;

  /** شناسهٔ سفارش زوپینی */
  @Column({ name: 'order_id', type: 'int' })
  orderId: number;

  /** شمارهٔ سفارش (برای خوانایی گزارش‌ها) */
  @Column({ name: 'order_number', type: 'varchar', length: 20 })
  orderNumber: string;

  @Column({
    type: 'enum',
    enum: RahkaranInvoiceSyncStatus,
    default: RahkaranInvoiceSyncStatus.PENDING,
  })
  status: RahkaranInvoiceSyncStatus;

  /** تعداد تلاش‌های انجام‌شده (موفق + ناموفق) */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** شناسهٔ فاکتور ثبت‌شده در راهکاران */
  @Column({ name: 'invoice_id', type: 'int', nullable: true })
  invoiceId: number | null;

  /** شمارهٔ فاکتور ثبت‌شده در راهکاران */
  @Column({
    name: 'invoice_number',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  invoiceNumber: string | null;

  /** آخرین correlationId مربوط به تلاش اخیر — کلید جستجو در لاگ‌ها */
  @Column({
    name: 'last_correlation_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastCorrelationId: string | null;

  /** خلاصهٔ آخرین خطا */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  /**
   * «نتیجهٔ نامعلوم» — زمان تشخیصِ وضعیتی که در آن درخواست به راهکاران
   * رسیده ولی پاسخ معتبر برنگشته است (Timeout/قطع اتصال/پاسخ بدشکل).
   *
   * در چنین حالتی ممکن است فاکتور در راهکاران ثبت شده باشد؛ پس ارسال دوباره
   * ممنوع است تا وقتی انسان وجود/عدم وجود فاکتور را در راهکاران بررسی کند.
   * `null` یعنی نتیجه قطعی بوده و retry خودکار مجاز است.
   */
  @Column({
    name: 'reconcile_required_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  reconcileRequiredAt: Date | null;

  /** دلیل کوتاه «نیازمند تطبیق» (برای نمایش در پنل مدیریت) */
  @Column({
    name: 'reconcile_reason',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  reconcileReason: string | null;

  @Column({
    name: 'last_attempt_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  lastAttemptAt: Date | null;

  @Column({
    name: 'succeeded_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  succeededAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
    onUpdate: 'CURRENT_TIMESTAMP(6)',
  })
  updatedAt: Date;
}
