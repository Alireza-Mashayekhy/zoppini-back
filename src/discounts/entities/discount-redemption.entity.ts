import { Order } from 'src/order/entities/order.entity';
import { User } from 'src/users/entities/user.entity';
import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Discount } from './discount.entity';

/**
 * هر بار استفادهٔ موفق از یک کد تخفیف.
 *
 * برخلاف `DiscountUsage` (جدول قدیمی با محدودیت یکتای discount+user)،
 * اینجا محدودیت یکتا وجود ندارد تا یک کاربر بتواند چند بار از کد استفاده کند.
 * سقف دفعات در `Discount.maxUsesPerUser` / `Discount.maxTotalUses` اعمال می‌شود.
 */
@Entity('discount_redemptions')
export class DiscountRedemption {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Discount, discount => discount.redemptions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'discount_id' })
  discount: Discount;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @CreateDateColumn()
  usedAt: Date;
}
