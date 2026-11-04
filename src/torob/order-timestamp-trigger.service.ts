import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

// Migrations precede synchronize. Install the trigger on a fresh development
// database after synchronize has created the order table.
@Injectable()
export class OrderTimestampTriggerService implements OnModuleInit {
  constructor(private readonly db: DataSource) {}

  async onModuleInit() {
    if (!this.db.options.synchronize) return;
    const triggers = await this.db.query(
      "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = 'order_set_updated_at_precision'",
    );
    if (!triggers.length) {
      await this.db.query(
        'CREATE TRIGGER `order_set_updated_at_precision` BEFORE UPDATE ON `order` FOR EACH ROW SET NEW.`updated_at` = CURRENT_TIMESTAMP(6)',
      );
    }
  }
}
