import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type FirstPurchaseGiftClaimStatus = 'reserved' | 'redeemed' | 'released';

/** One reusable reservation row per user; successful redemption stays permanent. */
@Entity('first_purchase_gift_claims')
@Index('UQ_first_purchase_gift_claim_user', ['userId'], { unique: true })
@Index('UQ_first_purchase_gift_claim_order', ['orderId'], { unique: true })
export class FirstPurchaseGiftClaim {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'order_id', type: 'int' })
  orderId: number;

  @Column({ type: 'enum', enum: ['reserved', 'redeemed', 'released'] })
  status: FirstPurchaseGiftClaimStatus;

  @Column({ name: 'discount_percent', type: 'decimal', precision: 5, scale: 2 })
  discountPercent: number;

  @Column({ name: 'discount_amount', type: 'decimal', precision: 15, scale: 2 })
  discountAmount: number;

  @Column({ name: 'reserved_until', type: 'datetime', nullable: true })
  reservedUntil: Date | null;

  @Column({ name: 'redeemed_at', type: 'datetime', nullable: true })
  redeemedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt: Date;
}
