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

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ nullable: true })
  saleOrderId: number; // شماره درخواست خرید

  @Column({ nullable: true })
  saleReferenceId: number; // کد مرجع تراکنش خرید

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
