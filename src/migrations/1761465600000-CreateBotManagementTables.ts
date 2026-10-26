import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * مایگریشن امن جداول ربات مدیریتی بله:
 *   - `bot_settings`: تنظیمات پایدار آستانهٔ کم‌موجودی، دسته‌های اعلان و وضعیت سینک راهکاران
 *   - `bot_operators`: نگاشت سرور-محور شناسهٔ عددی بله به نقش‌ها و گیرندگان مجاز اعلان
 *   - `bot_outbox_events`: جدول Transactional Outbox برای تحویل قابل‌اعتماد رویدادها با lease/ack و retry
 *   - `bot_inventory_alert_states`: وضعیت هشدار هر واریانت برای جلوگیری از تکرار هشدار در وضعیت ثابت
 *
 * تمام دستورات با `CREATE TABLE IF NOT EXISTS` نوشته شده‌اند تا هم روی دیتابیس
 * تولید (با `TYPEORM_SYNCHRONIZE=false`) و هم روی محیط‌هایی که قبلاً synchronize
 * روشن بوده بدون خطا و بدون دست‌زدن به جداول موجود فروشگاه اجرا شوند.
 */
export class CreateBotManagementTables1761465600000 implements MigrationInterface {
  name = 'CreateBotManagementTables1761465600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`bot_settings\` (
        \`id\` int NOT NULL DEFAULT 1,
        \`low_stock_threshold\` int NOT NULL DEFAULT 3,
        \`notify_order_created\` tinyint NOT NULL DEFAULT 1,
        \`notify_order_paid\` tinyint NOT NULL DEFAULT 1,
        \`notify_order_cancelled\` tinyint NOT NULL DEFAULT 1,
        \`notify_order_status_changed\` tinyint NOT NULL DEFAULT 1,
        \`notify_inventory_alerts\` tinyint NOT NULL DEFAULT 1,
        \`notify_sync_and_health\` tinyint NOT NULL DEFAULT 1,
        \`inventory_reminder_hours\` int NOT NULL DEFAULT 0,
        \`stale_sync_threshold_hours\` int NOT NULL DEFAULT 30,
        \`last_sync_started_at\` datetime NULL,
        \`last_sync_succeeded_at\` datetime NULL,
        \`last_sync_failed_at\` datetime NULL,
        \`last_sync_status\` varchar(24) NOT NULL DEFAULT 'never',
        \`last_sync_error\` varchar(500) NULL,
        \`last_sync_stats\` json NULL,
        \`sync_incident_open\` tinyint NOT NULL DEFAULT 0,
        \`sync_incident_count\` int NOT NULL DEFAULT 0,
        \`last_stale_alert_key\` varchar(120) NULL,
        \`updated_by_bale_id\` varchar(32) NULL,
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`bot_operators\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`bale_user_id\` varchar(32) NOT NULL,
        \`role\` enum('owner','admin','orders-read-only','reports-read-only') NOT NULL DEFAULT 'reports-read-only',
        \`label\` varchar(120) NULL,
        \`is_active\` tinyint NOT NULL DEFAULT 1,
        \`receive_order_alerts\` tinyint NOT NULL DEFAULT 1,
        \`receive_inventory_alerts\` tinyint NOT NULL DEFAULT 1,
        \`receive_health_alerts\` tinyint NOT NULL DEFAULT 1,
        \`updated_by_bale_id\` varchar(32) NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`UQ_bot_operators_bale_user_id\` (\`bale_user_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`bot_outbox_events\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`event_id\` varchar(36) NOT NULL,
        \`idempotency_key\` varchar(191) NOT NULL,
        \`event_type\` varchar(48) NOT NULL,
        \`category\` varchar(32) NOT NULL,
        \`status\` enum('pending','leased','delivered','failed','skipped') NOT NULL DEFAULT 'pending',
        \`payload\` json NOT NULL,
        \`attempts\` int NOT NULL DEFAULT 0,
        \`max_attempts\` int NOT NULL DEFAULT 8,
        \`available_at\` datetime NOT NULL,
        \`lease_owner\` varchar(64) NULL,
        \`lease_token\` varchar(64) NULL,
        \`leased_until\` datetime NULL,
        \`delivered_at\` datetime NULL,
        \`last_error\` varchar(500) NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`UQ_bot_outbox_event_id\` (\`event_id\`),
        UNIQUE INDEX \`UQ_bot_outbox_idempotency_key\` (\`idempotency_key\`),
        INDEX \`IDX_bot_outbox_poll\` (\`status\`, \`available_at\`, \`id\`),
        INDEX \`IDX_bot_outbox_created_at\` (\`created_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`bot_inventory_alert_states\` (
        \`variant_id\` int NOT NULL,
        \`state\` varchar(16) NOT NULL DEFAULT 'healthy',
        \`episode\` int NOT NULL DEFAULT 0,
        \`last_stock\` int NOT NULL DEFAULT 0,
        \`last_threshold\` int NOT NULL DEFAULT 3,
        \`last_alerted_at\` datetime NULL,
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`variant_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await queryRunner.query(`
      INSERT IGNORE INTO \`bot_settings\` (\`id\`, \`low_stock_threshold\`)
      VALUES (1, 3);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS `bot_inventory_alert_states`;',
    );
    await queryRunner.query('DROP TABLE IF EXISTS `bot_outbox_events`;');
    await queryRunner.query('DROP TABLE IF EXISTS `bot_operators`;');
    await queryRunner.query('DROP TABLE IF EXISTS `bot_settings`;');
  }
}
