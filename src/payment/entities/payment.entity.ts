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

@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  orderId: number; // شناسه سفارش

  @Column({ unique: true })
  refId: string; // RefId دریافتی از درگاه

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  amount: number;

  /**
   * شماره درخواست خرید نزد درگاه.
   *
   * در درگاه ملت این مقدار عددی ۱۶ رقمی است (Date.now() * 1000 + random)
   * که در ستون int جا نمی‌شد و سرریز می‌کرد؛ به همین دلیل bigint است.
   * (TypeORM برای bigint رشته برمی‌گرداند)
   */
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
