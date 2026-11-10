import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Payment, PaymentGateway } from './payment.entity';

export enum PaymentRefundStatus {
  /** درخواست ثبت شده ولی نتیجهٔ نهایی از سرویس استعلام مشخص نیست */
  PENDING = 'pending',
  /** طبق Refund Inquiry، عودت با موفقیت انجام شده است */
  SUCCESS = 'success',
  /** ثبت نشد یا خودِ عودت ناموفق بود (طبق resultCode) */
  FAILED = 'failed',
}

/**
 * ثبت هر درخواست «بازگشت خرید» (Refund) درگاه پرداخت.
 *
 * چرا جدول جدا؟
 * - مستند دیجی‌پی اجازهٔ Partial Refund می‌دهد؛ یعنی یک خرید می‌تواند چند
 *   درخواست عودت جدا داشته باشد و باید مجموعشان از مبلغ تراکنش بیشتر نشود.
 * - پاسخ ۲۰۰ در Refund فقط «ثبت موفق» است و نتیجهٔ نهایی با سرویس
 *   Refund Inquiry مشخص می‌شود؛ برای همین باید وضعیت هر درخواست جداگانه و
 *   قابل استعلام (و قابل retry) نگه داشته شود.
 */
@Entity('payment_refunds')
export class PaymentRefund {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'payment_id', type: 'int' })
  paymentId: number;

  @ManyToOne(() => Payment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment: Payment;

  @Column({ type: 'enum', enum: PaymentGateway })
  gateway: PaymentGateway;

  /**
   * شناسهٔ یکتای درخواست عودت که خودمان می‌سازیم.
   * تکرار همین شناسه با همان داده‌ها، پاسخ ثبت قبلی را برمی‌گرداند (idempotent).
   */
  @Column({ unique: true, length: 100 })
  providerId: string;

  /** مبلغ عودت به **ریال** (همان واحد payments.amount) */
  @Column({ type: 'decimal', precision: 15, scale: 2 })
  amount: number;

  /** کد پیگیری خرید اصلی (payments.saleReferenceId) */
  @Column({ name: 'sale_tracking_code', type: 'varchar', length: 64 })
  saleTrackingCode: string;

  /** نوع عودت مطابق جدول نوع عودت دیجی‌پی: 0=Debit، 5=Credit، 11=Wallet، 13=BNPL */
  @Column({ name: 'refund_type', type: 'int' })
  refundType: number;

  /** کد پیگیری عودت که دیجی‌پی برمی‌گرداند */
  @Column({
    name: 'tracking_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  trackingCode: string | null;

  @Index()
  @Column({
    type: 'enum',
    enum: PaymentRefundStatus,
    default: PaymentRefundStatus.PENDING,
  })
  status: PaymentRefundStatus;

  /** علت شکست عودت (resultCode سرویس استعلام) */
  @Column({ name: 'result_code', type: 'varchar', length: 32, nullable: true })
  resultCode: string | null;

  /** نوع مقصد عودت: 0=Masked PAN، 1=IBAN، 2=Wallet، 3=Credit */
  @Column({ name: 'destination_type', type: 'int', nullable: true })
  destinationType: number | null;

  /** تاریخ عودت وجه (Epoch Millisecond) */
  @Column({ name: 'transfer_date', type: 'bigint', nullable: true })
  transferDate: string | null;

  /** تعداد درخواست‌های ثبت/استعلام برای پایش و تشخیص حلقهٔ بی‌پایان */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({
    name: 'last_checked_at',
    type: 'datetime',
    nullable: true,
  })
  lastCheckedAt: Date | null;

  /** پاسخ خام سرویس Refund (برای بررسی دستی) */
  @Column({ name: 'raw_response', type: 'json', nullable: true })
  rawResponse: any;

  /** پیام آخرین خطا (برای نمایش به ادمین) */
  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
