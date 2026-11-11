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

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  saleDiscount: number;

  /** جمع تخفیف پروموشن‌های سبد (غیر از فروش ویژه و کد تخفیف) */
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  promotionDiscount: number;

  /** ارزش کالاهای رایگان پروموشن */
  @Column({
    name: 'promotion_free_item_value',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  promotionFreeItemValue: number;

  /**
   * اسنپ‌شات پروموشن‌های اعمال‌شده در لحظهٔ ثبت سفارش:
   * شناسه، نام، نوع، مبلغ تخفیف، اقلام واجد شرط/پاداش، قواعد.
   */
  @Column({ name: 'promotion_snapshot', type: 'json', nullable: true })
  promotionSnapshot: {
    promotionId: number;
    name: string;
    type: string;
    discountAmount: number;
    freeItemValue: number;
    grantsFreeShipping: boolean;
    qualifyingVariantIds: number[];
    rewardVariantIds: number[];
    rewardProductIds: number[];
    lines: { lineId: string; amount: number; isFree: boolean; label: string }[];
  }[] | null;

  /** آیا ارسال این سفارش با پروموشن رایگان شد */
  @Column({ name: 'promotion_free_shipping', type: 'boolean', default: false })
  promotionFreeShipping: boolean;

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

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  walletPayment: number;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  // Integration-only fields are never selected in the customer/admin order APIs.
  @Column({
    name: 'torob_clid',
    type: 'varchar',
    length: 255,
    nullable: true,
    select: false,
  })
  torobClid: string | null;

  @Column({
    name: 'torob_grant_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    select: false,
  })
  torobGrantId: string | null;

  @Column({
    name: 'torob_was_paid',
    type: 'boolean',
    default: false,
    select: false,
  })
  torobWasPaid: boolean;

  @Column({ name: 'address_id', nullable: true })
  addressId: number | null;

  @ManyToOne(() => Address, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'address_id' })
  address: Address | null;

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

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
    onUpdate: 'CURRENT_TIMESTAMP(6)',
  })
  updatedAt: Date;
}
