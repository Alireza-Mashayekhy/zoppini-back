import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Wallet } from './wallet.entity';

export enum WalletTransactionType {
  /** شارژ کیف پول (واریز از طریق درگاه پرداخت یا سرویس داخلی) */
  CHARGE = 'charge',
  /** خرید (کسر از کیف پول) */
  PURCHASE = 'purchase',
  /** عودت به کیف پول (مثلاً لغو سفارش) */
  REFUND = 'refund',
  /** برگشتِ یک تراکنش قبلی */
  REVERSAL = 'reversal',
  /** تنظیم دستی (ادمین) */
  ADJUSTMENT = 'adjustment',
}

export enum WalletTransactionDirection {
  CREDIT = 'credit',
  DEBIT = 'debit',
}

export enum WalletTransactionStatus {
  SUCCESS = 'success',
  REVERSED = 'reversed',
}

@Entity('wallet_transactions')
export class WalletTransaction {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Wallet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wallet_id' })
  @Index()
  wallet: Wallet;

  /** کلید یکتا برای idempotency */
  @Column({ unique: true, length: 191 })
  transactionKey: string;

  @Column({ type: 'enum', enum: WalletTransactionType })
  type: WalletTransactionType;

  /** جهت تراکنش: credit = واریز، debit = کسر */
  @Column({ type: 'enum', enum: WalletTransactionDirection })
  direction: WalletTransactionDirection;

  /** مبلغ تراکنش (همیشه عدد مثبت) */
  @Column({ type: 'decimal', precision: 15, scale: 2 })
  amount: number;

  /** موجودی کیف پول پس از این تراکنش (برای آدیت) */
  @Column({ type: 'decimal', precision: 15, scale: 2 })
  balanceAfter: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  /** داده‌های تکمیلی (orderId، chargeId، paymentId، ...) */
  @Column({ type: 'json', nullable: true })
  meta: any;

  @Column({
    type: 'enum',
    enum: WalletTransactionStatus,
    default: WalletTransactionStatus.SUCCESS,
  })
  status: WalletTransactionStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
