import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type VariantAlertState = 'healthy' | 'low' | 'out';

@Entity('bot_inventory_alert_states')
export class BotInventoryAlertState {
  @PrimaryColumn({ name: 'variant_id', type: 'int' })
  variantId: number;

  @Column({ type: 'varchar', length: 16, default: 'healthy' })
  state: VariantAlertState;

  @Column({ type: 'int', default: 0 })
  episode: number;

  @Column({ name: 'last_stock', type: 'int', default: 0 })
  lastStock: number;

  @Column({ name: 'last_threshold', type: 'int', default: 3 })
  lastThreshold: number;

  @Column({ name: 'last_alerted_at', type: 'datetime', nullable: true })
  lastAlertedAt: Date | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
