// src/orders/entities/order.entity.ts
import { Address } from 'src/address/entities/address.entity';
import { User } from 'src/users/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { ShippingMethod } from '../dto/create-order.dto';
import { OrderItem } from './order-item';

export enum OrderStatus {
  PENDING = 'pending',
  PAID = 'paid',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
}

@Entity()
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, length: 20 })
  orderNumber: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @OneToMany(() => OrderItem, item => item.order, { cascade: true })
  items: OrderItem[];

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  totalPrice: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  shippingCost: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  discount: number;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  discountCode: string | null;

  @Column({
    type: 'int',
    nullable: true,
  })
  discountId: number | null;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  finalPrice: number;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @Column({ name: 'address_id', nullable: true })
  addressId: number;

  @ManyToOne(() => Address, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'address_id' })
  address: Address;

  @Column({
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  note: string | null;

  @Column({ type: 'enum', enum: ShippingMethod, nullable: true })
  shippingMethod: ShippingMethod;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
