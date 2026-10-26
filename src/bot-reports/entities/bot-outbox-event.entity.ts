import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum BotEventType {
  ORDER_CREATED = 'order.created',
  ORDER_PAID = 'order.paid',
  ORDER_CANCELLED = 'order.cancelled',
  ORDER_REFUNDED = 'order.refunded',
  ORDER_STATUS_CHANGED = 'order.status_changed',
  INVENTORY_LOW_STOCK = 'inventory.low_stock',
  INVENTORY_OUT_OF_STOCK = 'inventory.out_of_stock',
  SYNC_FAILED = 'sync.failed',
  SYNC_RECOVERED = 'sync.recovered',
  SYNC_STALE = 'sync.stale',
}

export enum BotNotificationCategory {
  ORDER_CREATED = 'order_created',
  ORDER_PAID = 'order_paid',
  ORDER_CANCELLED = 'order_cancelled',
  ORDER_STATUS = 'order_status',
  INVENTORY = 'inventory',
  SYNC_HEALTH = 'sync_health',
}

export enum BotOutboxStatus {
  PENDING = 'pending',
  LEASED = 'leased',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

@Entity('bot_outbox_events')
@Index('IDX_bot_outbox_poll', ['status', 'availableAt', 'id'])
@Index('IDX_bot_outbox_created_at', ['createdAt'])
export class BotOutboxEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('UQ_bot_outbox_event_id', { unique: true })
  @Column({ name: 'event_id', type: 'varchar', length: 36 })
  eventId: string;

  @Index('UQ_bot_outbox_idempotency_key', { unique: true })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 191 })
  idempotencyKey: string;

  @Column({ name: 'event_type', type: 'varchar', length: 48 })
  eventType: BotEventType;

  @Column({ type: 'varchar', length: 32 })
  category: BotNotificationCategory;

  @Column({
    type: 'enum',
    enum: BotOutboxStatus,
    default: BotOutboxStatus.PENDING,
  })
  status: BotOutboxStatus;

  /**
   * Payload کمینه و عاری از اطلاعات حساس مشتری یا پاسخ خام درگاه پرداخت.
   */
  @Column({ type: 'json' })
  payload: Record<string, unknown>;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'max_attempts', type: 'int', default: 8 })
  maxAttempts: number;

  @Column({ name: 'available_at', type: 'datetime' })
  availableAt: Date;

  @Column({ name: 'lease_owner', type: 'varchar', length: 64, nullable: true })
  leaseOwner: string | null;

  @Column({ name: 'lease_token', type: 'varchar', length: 64, nullable: true })
  leaseToken: string | null;

  @Column({ name: 'leased_until', type: 'datetime', nullable: true })
  leasedUntil: Date | null;

  @Column({ name: 'delivered_at', type: 'datetime', nullable: true })
  deliveredAt: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
