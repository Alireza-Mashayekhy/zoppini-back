import { Order } from 'src/order/entities/order.entity';
import { User } from 'src/users/entities/user.entity';
import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { Discount } from './discount.entity';

@Entity('discount_usages')
@Unique(['discount', 'user'])
export class DiscountUsage {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Discount, discount => discount.usages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'discount_id' })
  discount: Discount;

  @ManyToOne(() => User, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Order, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @CreateDateColumn()
  usedAt: Date;
}
