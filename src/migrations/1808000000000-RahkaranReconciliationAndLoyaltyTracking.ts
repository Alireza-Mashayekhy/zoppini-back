import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ستون‌های لازم برای «نتیجهٔ نامعلوم» و «ثبت یک‌بارهٔ باشگاه وفاداری».
 *
 * ── چرا این تغییر لازم است؟ ────────────────────────────────────────────────
 * ۱) `rahkaran_invoice_sync.reconcile_required_at`
 *    وقتی درخواست `SaveInvoice` به راهکاران می‌رسد ولی پاسخ برنمی‌گردد
 *    (Timeout، قطع اتصال، پاسخ با ساختار نامعتبر) نمی‌دانیم فاکتور ثبت شده
 *    یا نه. تا امروز چنین تلاشی `failed` علامت می‌خورد و scheduler آن را
 *    دوباره می‌فرستاد → احتمال فاکتور تکراری. این ستون «نیازمند تطبیق»
 *    را علامت می‌زند تا retry خودکار برای آن متوقف شود.
 *
 * ۲) `user.loyalty_member_synced_at`
 *    ثبت مشتری و عضویت وفاداری در راهکاران دو عملیات جدا هستند و قبلاً هیچ
 *    ردی از موفقیتشان ذخیره نمی‌شد؛ هر فراخوانی دوباره مشتری می‌ساخت
 *    (احتمال مشتری تکراری در راهکاران). با این ستون، ثبت یک‌باره می‌شود و
 *    عملیات نیمه‌تمام قابل تکمیل است.
 *
 * توجه: جدول entity `User` (`@Entity() export class User`) در MySQL با نام
 * مفرد `user` ساخته می‌شود (مشابه `order`، `cart` و `category`).
 * ستون `user.rahkaranId` از قبل وجود دارد و همین‌جا فقط استفاده می‌شود.
 *
 * Migration فقط افزودنی است (ADD COLUMN با شرط وجود) و `down` آن ستون‌ها را
 * برمی‌دارد؛ هیچ داده‌ای حذف یا بازنویسی نمی‌شود.
 */
export class RahkaranReconciliationAndLoyaltyTracking1808000000000 implements MigrationInterface {
  private async tableExists(queryRunner: QueryRunner, table: string) {
    const rows: { COUNT: string | number }[] = await queryRunner.query(
      `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );

    return Number(rows?.[0]?.COUNT ?? 0) > 0;
  }

  private async columnExists(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ) {
    const rows: { COUNT: string | number }[] = await queryRunner.query(
      `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );

    return Number(rows?.[0]?.COUNT ?? 0) > 0;
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.tableExists(queryRunner, 'rahkaran_invoice_sync')) {
      if (
        !(await this.columnExists(
          queryRunner,
          'rahkaran_invoice_sync',
          'reconcile_required_at',
        ))
      ) {
        await queryRunner.query(
          'ALTER TABLE `rahkaran_invoice_sync` ' +
            'ADD COLUMN `reconcile_required_at` DATETIME(6) NULL',
        );
      }

      if (
        !(await this.columnExists(
          queryRunner,
          'rahkaran_invoice_sync',
          'reconcile_reason',
        ))
      ) {
        await queryRunner.query(
          'ALTER TABLE `rahkaran_invoice_sync` ' +
            'ADD COLUMN `reconcile_reason` VARCHAR(255) NULL',
        );
      }
    }

    if (
      (await this.tableExists(queryRunner, 'user')) &&
      !(await this.columnExists(
        queryRunner,
        'user',
        'loyalty_member_synced_at',
      ))
    ) {
      await queryRunner.query(
        'ALTER TABLE `user` ' +
          'ADD COLUMN `loyalty_member_synced_at` DATETIME(6) NULL',
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (
      (await this.tableExists(queryRunner, 'rahkaran_invoice_sync')) &&
      (await this.columnExists(
        queryRunner,
        'rahkaran_invoice_sync',
        'reconcile_required_at',
      ))
    ) {
      await queryRunner.query(
        'ALTER TABLE `rahkaran_invoice_sync` DROP COLUMN `reconcile_required_at`',
      );
    }

    if (
      (await this.tableExists(queryRunner, 'rahkaran_invoice_sync')) &&
      (await this.columnExists(
        queryRunner,
        'rahkaran_invoice_sync',
        'reconcile_reason',
      ))
    ) {
      await queryRunner.query(
        'ALTER TABLE `rahkaran_invoice_sync` DROP COLUMN `reconcile_reason`',
      );
    }

    if (
      (await this.tableExists(queryRunner, 'user')) &&
      (await this.columnExists(queryRunner, 'user', 'loyalty_member_synced_at'))
    ) {
      await queryRunner.query(
        'ALTER TABLE `user` DROP COLUMN `loyalty_member_synced_at`',
      );
    }
  }
}
