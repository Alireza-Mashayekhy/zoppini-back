import { Order } from 'src/order/entities/order.entity';
import { User } from 'src/users/entities/user.entity';
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

import { Promotion } from './promotion.entity';

/** یک استفادهٔ نهایی‌شده از پروموشن (هنگام پرداخت موفق سفارش) */
@Entity('promotion_redemptions')
export class PromotionRedemption {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @ManyToOne(() => Promotion, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'promotion_id' })
  promotion: Promotion;

  @Column({ name: 'promotion_id' })
  promotionId: number;

  /** برای سفارش مهمان null است */
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ name: 'user_id', nullable: true })
  userId: number | null;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ name: 'order_id' })
  orderId: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  discountAmount: number;

  @CreateDateColumn()
  usedAt: Date;
}

/**
 * رد استفاده از پروموشن (پشتیبانی/گزارش).
 * چیزی که مشتری ممکن است در سبد ببیند ولی پیش از پرداخت از دست بدهد.
 */
export enum PromotionEventKind {
  EXPIRED = 'expired',
  INELIGIBLE = 'ineligible',
  OUT_OF_STOCK = 'out_of_stock',
  USAGE_LIMIT = 'usage_limit',
  STACKING_BLOCKED = 'stacking_blocked',
  REWARD_ACCEPTED = 'reward_accepted',
  REWARD_DECLINED = 'reward_declined',
  REWARD_REMOVED = 'reward_removed',
  POPUP_ACCEPTED = 'popup_accepted',
  POPUP_DISMISSED = 'popup_dismissed',
}

@Entity('promotion_events')
export class PromotionEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @ManyToOne(() => Promotion, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'promotion_id' })
  promotion: Promotion;

  @Column({ name: 'promotion_id' })
  promotionId: number;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ name: 'user_id', nullable: true })
  userId: number | null;

  @Column({ type: 'enum', enum: PromotionEventKind })
  kind: PromotionEventKind;

  @Column({ type: 'varchar', length: 500, nullable: true })
  message: string | null;

  @Column({ type: 'json', nullable: true })
  meta: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
