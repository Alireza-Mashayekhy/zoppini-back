import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * صلاحیت «تخفیف عمومی سبد» روی محصولات دارای تخفیف:
 *
 * - `promotions.applyToDiscountedProducts` (tinyint, پیش‌فرض ۰):
 *   محصولی که خودش تخفیف سطح محصول دارد از تخفیف سبد مستثنی است؛
 *   ادمین می‌تواند برای هر پروموشن «تخفیف سبد» روشن کند.
 * - `promotions.cartDiscountBase` (enum, پیش‌فرض 'discounted_price'):
 *   مبنای محاسبهٔ تخفیف سبد؛ «discounted_price» متوالی روی قیمت پس از
 *   تخفیف محصول (رفتار قبلی)، «original_price» جمعی روی قیمت فهرست.
 * - `order_item.sale_discount` (decimal, پیش‌فرض ۰):
 *   تخفیف سطح محصول (فروش ویژه) به تفکیک ردیف سفارش؛ تا سفارش همهٔ
 *   اجزای تخفیف را حفظ کند.
 *
 * مثل 1802000000000-PromotionSystem محافظه‌کار است: هر ستون فقط اگر
 * وجود نداشته باشد اضافه می‌شود تا اجرای مجدد و نصب‌های تازه هر دو سالم
 * بمانند. رکوردهای موجود مقدار پیش‌فرض می‌گیرند و رفتار قبلی (برای
 * محصولات بدون تخفیف و حالت متوالی) دست‌نخورده می‌ماند.
 */
export class CartDiscountEligibility1807000000000 implements MigrationInterface {
  private async tableExists(q: QueryRunner, table: string) {
    const rows: { COUNT: string | number }[] = await q.query(
      `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );

    return Number(rows?.[0]?.COUNT ?? 0) > 0;
  }

  private async columnExists(q: QueryRunner, table: string, column: string) {
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
  ) {
    if (!(await this.tableExists(q, table))) {
      return;
    }

    if (await this.columnExists(q, table, column)) {
      return;
    }

    await q.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`,
    );
  }

  async up(q: QueryRunner): Promise<void> {
    await this.addColumn(
      q,
      'promotions',
      'applyToDiscountedProducts',
      'tinyint NOT NULL DEFAULT 0',
    );

    await this.addColumn(
      q,
      'promotions',
      'cartDiscountBase',
      "enum('discounted_price','original_price') NOT NULL DEFAULT 'discounted_price'",
    );

    await this.addColumn(
      q,
      'order_item',
      'sale_discount',
      'decimal(15,2) NOT NULL DEFAULT 0.00',
    );
  }

  async down(q: QueryRunner): Promise<void> {
    const dropColumns: [string, string][] = [
      ['order_item', 'sale_discount'],
      ['promotions', 'cartDiscountBase'],
      ['promotions', 'applyToDiscountedProducts'],
    ];

    for (const [table, column] of dropColumns) {
      if (!(await this.tableExists(q, table))) {
        continue;
      }

      if (!(await this.columnExists(q, table, column))) {
        continue;
      }

      await q.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
    }
  }
}
