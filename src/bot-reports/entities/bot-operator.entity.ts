import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum BotOperatorRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  ORDERS_READ_ONLY = 'orders-read-only',
  REPORTS_READ_ONLY = 'reports-read-only',
}

@Entity('bot_operators')
export class BotOperator {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('UQ_bot_operators_bale_user_id', { unique: true })
  @Column({ name: 'bale_user_id', type: 'varchar', length: 32 })
  baleUserId: string;

  @Column({
    type: 'enum',
    enum: BotOperatorRole,
    default: BotOperatorRole.REPORTS_READ_ONLY,
  })
  role: BotOperatorRole;

  @Column({ type: 'varchar', length: 120, nullable: true })
  label: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'receive_order_alerts', type: 'boolean', default: true })
  receiveOrderAlerts: boolean;

  @Column({ name: 'receive_inventory_alerts', type: 'boolean', default: true })
  receiveInventoryAlerts: boolean;

  @Column({ name: 'receive_health_alerts', type: 'boolean', default: true })
  receiveHealthAlerts: boolean;

  @Column({
    name: 'updated_by_bale_id',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  updatedByBaleId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
