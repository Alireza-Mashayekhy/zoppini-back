import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * جدول ردیابی ثبت فاکتور سفارش‌ها در راهکاران.
 *
 * این جدول وضعیت هر ثبت فاکتور (pending/processing/success/failed)،
 * تعداد تلاش‌ها، شناسهٔ فاکتور راهکاران و آخرین correlationId را نگه
 * می‌دارد تا فاکتورهای ثبت‌نشده قابل شناسایی و retry باشند.
 */
export class RahkaranInvoiceSync1805000000000 implements MigrationInterface {
  private async tableExists(queryRunner: QueryRunner, table: string) {
    const rows: { COUNT: string | number }[] = await queryRunner.query(
      `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return Number(rows?.[0]?.COUNT ?? 0) > 0;
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.tableExists(queryRunner, 'rahkaran_invoice_sync')) {
      return;
    }

    await queryRunner.query(`
      CREATE TABLE \`rahkaran_invoice_sync\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`order_id\` INT NOT NULL,
        \`order_number\` VARCHAR(20) NOT NULL,
        \`status\` ENUM('pending','processing','success','failed') NOT NULL DEFAULT 'pending',
        \`attempts\` INT NOT NULL DEFAULT 0,
        \`invoice_id\` INT NULL,
        \`invoice_number\` VARCHAR(64) NULL,
        \`last_correlation_id\` VARCHAR(64) NULL,
        \`last_error\` TEXT NULL,
        \`last_attempt_at\` DATETIME(6) NULL,
        \`succeeded_at\` DATETIME(6) NULL,
        \`created_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`UQ_rahkaran_invoice_sync_order\` (\`order_id\`),
        KEY \`IDX_rahkaran_invoice_sync_status\` (\`status\`, \`attempts\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.tableExists(queryRunner, 'rahkaran_invoice_sync')) {
      await queryRunner.query(`DROP TABLE \`rahkaran_invoice_sync\``);
    }
  }
}
