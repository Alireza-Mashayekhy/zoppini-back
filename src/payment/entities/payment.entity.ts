import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PaymentStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  VERIFIED = 'verified',
  SETTLED = 'settled',
}

export enum PaymentGateway {
  MELLAT = 'mellat',
  ZARINPAL = 'zarinpal',
  DIGIPAY = 'digipay',
  TARA = 'tara',
  SNAPPAY = 'snappay',
}

export enum PaymentPurpose {
  ORDER = 'order',
  WALLET_CHARGE = 'wallet_charge',
}

@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true })
  orderId: number | null;

  /** هدف پرداخت: سفارش یا شارژ کیف پول */
  @Column({ type: 'enum', enum: PaymentPurpose, default: PaymentPurpose.ORDER })
  purpose: PaymentPurpose;

  /** شناسه درخواست شارژ کیف پول (فقط برای پرداخت‌های WALLET_CHARGE) */
  @Column({ type: 'int', nullable: true })
  walletChargeId: number | null;

  @Column({ unique: true })
  refId: string; // شناسهٔ اولیهٔ دریافتی از درگاه (مثلاً ticket یا authority)

  @Column({ type: 'varchar', length: 100, nullable: true, unique: true })
  providerId: string | null;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  amount: number;

  @Column({ type: 'bigint', nullable: true })
  saleOrderId: string | null;

  /**
   * کد مرجع تراکنش خرید.
   *
   * - ملت: saleReferenceId (عدد بزرگ)
   * - تارا: rrn که در مستندات نوعش string است
   * پس به‌صورت varchar نگهداری می‌شود تا مقدار خراب نشود.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  saleReferenceId: string | null;

  /**
   * کد مرجع ارسالی تارا در callback (channelRefNumber).
   * برای پیگیری و سرویس‌های برگشت وجه (refund) لازم است.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  channelRefNumber: string | null;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  //==============================================================
  // دیجی‌پی (UPG) — اطلاعات خرید اعتباری/اقساطی
  //==============================================================

  /**
   * نوع خرید دیجی‌پی که از **callback** می‌آید (نه نوع تیکت اولیهٔ UPG).
   * 0 = IPG (درگاه اینترنتی)، 5 = Credit (CPG)، 11 = Wallet،
   * 13 = BNPL (BPG)، 24 = Credit-Card
   */
  @Column({ name: 'digipay_purchase_type', type: 'int', nullable: true })
  digipayPurchaseType: number | null;

  /**
   * ابزار پرداخت تأییدشدهٔ دیجی‌پی از پاسخ `purchases/verify`:
   * 3 = Wallet، 4 = CPG/اعتباری، 10 = BPG/BNPL
   */
  @Column({ name: 'digipay_payment_gateway', type: 'int', nullable: true })
  digipayPaymentGateway: number | null;

  /** تأمین‌کنندهٔ اعتبار (`fpName` در verify یا `creditProvider` در callback) */
  @Column({
    name: 'credit_provider',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  creditProvider: string | null;

  /**
   * روش بازپرداخت اعتبار دیجی‌پی: 0 = تک‌مرحله‌ای (یک‌جا)،
   * 1 = چندمرحله‌ای (۴ قسط). در callback اعتباری/BNPL ارسال می‌شود.
   */
  @Column({ name: 'repayment_option', type: 'int', nullable: true })
  repaymentOption: number | null;

  /**
   * زمان اعلام تحویل خرید اعتباری به دیجی‌پی (`purchases/deliver`).
   * فقط برای خریدهای CREDIT و BNPL لازم است و برای جلوگیری از ارسال
   * تکراری، تاریخ موفق‌ترین اعلام در این ستون نگه داشته می‌شود.
   */
  @Column({
    name: 'digipay_delivered_at',
    type: 'datetime',
    nullable: true,
  })
  digipayDeliveredAt: Date | null;

  @Column({ type: 'enum', enum: PaymentGateway })
  gateway: PaymentGateway;

  @Column({ type: 'json', nullable: true })
  gatewayResponse: any; // پاسخ کامل درگاه

  @Column({ nullable: true })
  resCode: string; // کد پاسخ از درگاه

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
