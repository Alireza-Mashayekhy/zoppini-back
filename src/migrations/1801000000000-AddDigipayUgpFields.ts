import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * فیلدهای تکمیلی دیجی‌پی (UPG) + جدول عودت‌های درگاه
 *
 * چرا لازم است؟
 * - مستند UPG نوع خرید (Wallet/Credit/BNPL/IPG) را فقط در callback اعلام
 *   می‌کند و ابزار واقعی پرداخت (`paymentGateway`) را در پاسخ verify؛ بدون
 *   ذخیرهٔ آن‌ها نه اعلام تحویل (Delivery) و نه عودت (Refund) درست ممکن نیست.
 * - عودت‌ها Partial هستند و نتیجهٔ نهایی با Refund Inquiry می‌آید؛ پس هر
 *   درخواست یک رکورد قابل پیگیری لازم دارد.
 *
 * این مایگریشن محافظه‌کار است (مثل AddSnappayGateway):
 * - اگر جدول payments نباشد (نصب تازه با synchronize) هیچ کاری نمی‌کند.
 * - هر ستون فقط اگر وجود نداشته باشد اضافه می‌شود.
 * - در down فقط ستون‌های همین مایگریشن و تنها در صورت نبودن دادهٔ عودت حذف
 *   می‌شوند تا داده‌ای سکوتاً از بین نرود.
 */
export class AddDigipayUgpFields1801000000000 implements MigrationInterface {
  private async tableExists(q: QueryRunner, table: string): Promise<boolean> {
    const rows: { COUNT: string | number }[] = await q.query(
      `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );

    return Number(rows?.[0]?.COUNT ?? 0) > 0;
  }

  private async columnExists(
    q: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows: { COUNT: string | number }[] = await q.query(
      `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );

    return Number(rows?.[0]?.COUNT ?? 0) > 0;
  }

  private async addColumn(
    q: QueryRunner,
    table: string,
    column: string,
    definition: string,
  ): Promise<void> {
    if (await this.columnExists(q, table, column)) {
      return;
    }

    await q.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`,
    );
  }

  async up(q: QueryRunner): Promise<void> {
    if (await this.tableExists(q, 'payments')) {
      await this.addColumn(q, 'payments', 'digipay_purchase_type', 'INT NULL');
      await this.addColumn(
        q,
        'payments',
        'digipay_payment_gateway',
        'INT NULL',
      );
      await this.addColumn(
        q,
        'payments',
        'credit_provider',
        'VARCHAR(64) NULL',
      );
      await this.addColumn(q, 'payments', 'repayment_option', 'INT NULL');
      await this.addColumn(
        q,
        'payments',
        'digipay_delivered_at',
        'DATETIME NULL',
      );
    }

    await q.query(
      `CREATE TABLE IF NOT EXISTS \`payment_refunds\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`payment_id\` INT NOT NULL,
        \`gateway\` ENUM('mellat','zarinpal','digipay','tara','snappay') NOT NULL,
        \`providerId\` VARCHAR(100) NOT NULL,
        \`amount\` DECIMAL(15,2) NOT NULL,
        \`sale_tracking_code\` VARCHAR(64) NOT NULL,
        \`refund_type\` INT NOT NULL,
        \`tracking_code\` VARCHAR(64) NULL,
        \`status\` ENUM('pending','success','failed') NOT NULL DEFAULT 'pending',
        \`result_code\` VARCHAR(32) NULL,
        \`destination_type\` INT NULL,
        \`transfer_date\` BIGINT NULL,
        \`attempts\` INT NOT NULL DEFAULT 0,
        \`last_checked_at\` DATETIME NULL,
        \`raw_response\` JSON NULL,
        \`last_error\` VARCHAR(500) NULL,
        \`created_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`UQ_payment_refunds_providerId\` (\`providerId\`),
        KEY \`IDX_payment_refunds_payment_id\` (\`payment_id\`),
        KEY \`IDX_payment_refunds_status\` (\`status\`),
        CONSTRAINT \`FK_payment_refunds_payment\` FOREIGN KEY (\`payment_id\`)
          REFERENCES \`payments\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    if (await this.tableExists(q, 'payment_refunds')) {
      const rows: { COUNT: string | number }[] = await q.query(
        `SELECT COUNT(*) AS COUNT FROM \`payment_refunds\``,
      );

      // اگر عودتی ثبت شده باشد، حذف جدول یعنی از دست رفتن سابقهٔ پول؛ متوقف می‌شویم.
      if (Number(rows?.[0]?.COUNT ?? 0) === 0) {
        await q.query('DROP TABLE `payment_refunds`');
      }
    }

    if (!(await this.tableExists(q, 'payments'))) {
      return;
    }

    for (const column of [
      'digipay_delivered_at',
      'repayment_option',
      'credit_provider',
      'digipay_payment_gateway',
      'digipay_purchase_type',
    ]) {
      if (await this.columnExists(q, 'payments', column)) {
        await q.query(`ALTER TABLE \`payments\` DROP COLUMN \`${column}\``);
      }
    }
  }
}
