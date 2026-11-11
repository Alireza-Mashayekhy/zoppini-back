import { User } from 'src/users/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { CartItem } from './cart-item.entity';

@Entity()
export class Cart {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ nullable: true, unique: true })
  guestId: string;

  @OneToMany(() => CartItem, item => item.cart, { cascade: true })
  items: CartItem[];

  /** پروموشن‌هایی که مشتری صریحاً پذیرفته است (JSON: number[]) */
  @Column({ name: 'accepted_promotions', type: 'json', nullable: true })
  acceptedPromotions: number[] | null;

  /** پروموشن‌هایی که مشتری برای پاپ‌آپ رد کرده است (یک بار نمایش) */
  @Column({ name: 'dismissed_promotions', type: 'json', nullable: true })
  dismissedPromotions: number[] | null;

  /** پاداش انتخابی مشتری برای پروموشن‌های «انتخاب با مشتری» */
  @Column({ name: 'selected_rewards', type: 'json', nullable: true })
  selectedRewards: {
    promotionId: number;
    productId: number;
    variantId: number | null;
  }[] | null;

  /** آخرین اثرانگشت سبد برای تصمیم «پاپ‌آپ یک بار» */
  @Column({
    name: 'promotion_popup_shown_for',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  promotionPopupShownFor: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
