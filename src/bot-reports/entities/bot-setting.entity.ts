import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type BotSyncRunStatus =
  'never' | 'running' | 'ok' | 'partial_error' | 'failed';

export interface BotSyncStatsSnapshot {
  received: number;
  matched: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  durationSeconds: number;
}

@Entity('bot_settings')
export class BotSetting {
  @PrimaryColumn({ type: 'int', default: 1 })
  id: number;

  @Column({ name: 'low_stock_threshold', type: 'int', default: 3 })
  lowStockThreshold: number;

  @Column({ name: 'notify_order_created', type: 'boolean', default: true })
  notifyOrderCreated: boolean;

  @Column({ name: 'notify_order_paid', type: 'boolean', default: true })
  notifyOrderPaid: boolean;

  @Column({ name: 'notify_order_cancelled', type: 'boolean', default: true })
  notifyOrderCancelled: boolean;

  @Column({
    name: 'notify_order_status_changed',
    type: 'boolean',
    default: true,
  })
  notifyOrderStatusChanged: boolean;

  @Column({ name: 'notify_inventory_alerts', type: 'boolean', default: true })
  notifyInventoryAlerts: boolean;

  @Column({ name: 'notify_sync_and_health', type: 'boolean', default: true })
  notifySyncAndHealth: boolean;

  @Column({ name: 'inventory_reminder_hours', type: 'int', default: 0 })
  inventoryReminderHours: number;

  @Column({ name: 'stale_sync_threshold_hours', type: 'int', default: 30 })
  staleSyncThresholdHours: number;

  @Column({ name: 'last_sync_started_at', type: 'datetime', nullable: true })
  lastSyncStartedAt: Date | null;

  @Column({ name: 'last_sync_succeeded_at', type: 'datetime', nullable: true })
  lastSyncSucceededAt: Date | null;

  @Column({ name: 'last_sync_failed_at', type: 'datetime', nullable: true })
  lastSyncFailedAt: Date | null;

  @Column({
    name: 'last_sync_status',
    type: 'varchar',
    length: 24,
    default: 'never',
  })
  lastSyncStatus: BotSyncRunStatus;

  @Column({
    name: 'last_sync_error',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  lastSyncError: string | null;

  @Column({ name: 'last_sync_stats', type: 'json', nullable: true })
  lastSyncStats: BotSyncStatsSnapshot | null;

  @Column({ name: 'sync_incident_open', type: 'boolean', default: false })
  syncIncidentOpen: boolean;

  @Column({ name: 'sync_incident_count', type: 'int', default: 0 })
  syncIncidentCount: number;

  @Column({
    name: 'last_stale_alert_key',
    type: 'varchar',
    length: 120,
    nullable: true,
  })
  lastStaleAlertKey: string | null;

  @Column({
    name: 'updated_by_bale_id',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  updatedByBaleId: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
