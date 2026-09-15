import { User } from 'src/users/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('wallets')
export class Wallet {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** موجودی فعلی کیف پول */
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  balance: number;

  /** جمع کل شارژهای واریز‌شده به کیف پول */
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  totalCharged: number;

  /** جمع کل کسرهای انجام‌شده (خرید) */
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  totalSpent: number;

  /** جمع کل عودتهای واریز‌شده به کیف پول */
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  totalRefunded: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
