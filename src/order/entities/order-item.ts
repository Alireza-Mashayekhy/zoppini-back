import { Variant } from 'src/products/entities/variant.entity';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Order } from './order.entity';

@Entity()
export class OrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Order, order => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ name: 'variant_id', nullable: true })
  variantId: number | null;

  @ManyToOne(() => Variant, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'variant_id' })
  variant: Variant | null;

  @Column({ type: 'int' })
  quantity: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  price: number; // قیمت در زمان خرید (فریز شده)

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  originalPrice: number | null;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  totalPrice: number;

  // =====================================================
  // پروموشن‌ها (برای پشتیبانی و گزارش)
  // =====================================================

  /** تخفیف پروموشن روی این ردیف (تومان) */
  @Column({
    name: 'promotion_discount',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  promotionDiscount: number;

  /** آیا این ردیف کالای رایگان پروموشن است */
  @Column({ name: 'is_promotion_reward', type: 'boolean', default: false })
  isPromotionReward: boolean;

  /** پروموشنی که این ردیف را رایگان کرده */
  @Column({ name: 'promotion_reward_id', type: 'int', nullable: true })
  promotionRewardId: number | null;

  /** منطق اعمال‌شده روی این ردیف (متن قابل نمایش به پشتیبانی) */
  @Column({
    name: 'promotion_label',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  promotionLabel: string | null;

  /** شناسهٔ پروموشن‌های مؤثر بر ردیف (JSON) */
  @Column({ name: 'promotion_ids', type: 'json', nullable: true })
  promotionIds: number[] | null;
}
