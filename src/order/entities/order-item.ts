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

  @ManyToOne(() => Variant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'variant_id' })
  variant: Variant;

  @Column({ type: 'int' })
  quantity: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number; // قیمت در زمان خرید (فریز شده)

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  totalPrice: number;
}
