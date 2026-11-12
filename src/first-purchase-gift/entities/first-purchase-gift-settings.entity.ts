import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export type FirstPurchaseGiftPopupFrequency = 'session' | 'daily' | 'always';

@Entity('first_purchase_gift_settings')
export class FirstPurchaseGiftSettings {
  @PrimaryColumn({ type: 'tinyint', unsigned: true })
  id: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({
    name: 'discount_percent',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 15,
  })
  discountPercent: number;

  @Column({ type: 'varchar', length: 150, default: 'هدیه اولین خرید' })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ name: 'starts_at', type: 'datetime', nullable: true })
  startsAt: Date | null;

  @Column({ name: 'ends_at', type: 'datetime', nullable: true })
  endsAt: Date | null;

  @Column({ name: 'popup_enabled', type: 'boolean', default: true })
  popupEnabled: boolean;

  @Column({ name: 'announcement_enabled', type: 'boolean', default: true })
  announcementEnabled: boolean;

  @Column({
    name: 'popup_frequency',
    type: 'enum',
    enum: ['session', 'daily', 'always'],
    default: 'session',
  })
  popupFrequency: FirstPurchaseGiftPopupFrequency;

  @Column({
    name: 'stack_with_discount_codes',
    type: 'boolean',
    default: false,
  })
  stackWithDiscountCodes: boolean;

  @Column({ name: 'stack_with_sale_prices', type: 'boolean', default: false })
  stackWithSalePrices: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt: Date;
}
