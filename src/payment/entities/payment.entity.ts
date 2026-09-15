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
  refId: string; // RefId دریافتی از درگاه

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
