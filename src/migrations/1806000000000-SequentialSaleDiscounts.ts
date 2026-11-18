import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * افزودن پشتیبانی از «تخفیف‌های متوالی» به جدول discounts.
 *
 * ستون‌ها با مقدار پیش‌فرض اضافه می‌شوند تا همهٔ رکوردهای قبلی دقیقاً با
 * رفتار فعلی (فقط بهترین تخفیف، دامنهٔ انتخاب‌شده) کار کنند:
 *  - stackable: تخفیف به‌عنوان مرحلهٔ متوالی اعمال شود؟ (پیش‌فرض ۰ = خیر)
 *  - stackPriority: ترتیب مرحله (عدد کوچک‌تر = زودتر، پیش‌فرض ۰)
 *  - appliesToAllProducts: دامنهٔ «همهٔ محصولات» (پیش‌فرض ۰ = خیر)
 *
 * در محیط توسعه `synchronize` هم همین ستون‌ها را می‌سازد؛ این مایگریشن برای
 * محیط تولید و به‌صورت idempotent نوشته شده است. در نصب کاملاً تازه که جدول
 * discounts هنوز ساخته نشده، هیچ کاری نمی‌کند (synchronize بعداً می‌سازد).
 */
export class SequentialSaleDiscounts1806000000000 implements MigrationInterface {
  name = 'SequentialSaleDiscounts1806000000000';

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

  private async addColumnIfMissing(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    definition: string,
  ) {
    if (await this.columnExists(queryRunner, table, column)) {
      return;
    }

    await queryRunner.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`,
    );
  }

  private async dropColumnIfExists(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ) {
    if (!(await this.columnExists(queryRunner, table, column))) {
      return;
    }

    await queryRunner.query(
      `ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``,
    );
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.tableExists(queryRunner, 'discounts'))) {
      return;
    }

    await this.addColumnIfMissing(
      queryRunner,
      'discounts',
      'stackable',
      'TINYINT NOT NULL DEFAULT 0',
    );

    await this.addColumnIfMissing(
      queryRunner,
      'discounts',
      'stackPriority',
      'INT NOT NULL DEFAULT 0',
    );

    await this.addColumnIfMissing(
      queryRunner,
      'discounts',
      'appliesToAllProducts',
      'TINYINT NOT NULL DEFAULT 0',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.tableExists(queryRunner, 'discounts'))) {
      return;
    }

    await this.dropColumnIfExists(
      queryRunner,
      'discounts',
      'appliesToAllProducts',
    );

    await this.dropColumnIfExists(queryRunner, 'discounts', 'stackPriority');

    await this.dropColumnIfExists(queryRunner, 'discounts', 'stackable');
  }
}
