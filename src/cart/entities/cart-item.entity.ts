import { Variant } from 'src/products/entities/variant.entity';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Cart } from './cart.entity';

@Entity()
export class CartItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Cart, cart => cart.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cart_id' })
  cart: Cart;

  @ManyToOne(() => Variant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'variant_id' })
  variant: Variant;

  @Column({ type: 'int', default: 1 })
  quantity: number;
}
