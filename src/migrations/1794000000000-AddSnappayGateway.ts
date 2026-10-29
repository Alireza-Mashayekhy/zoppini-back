import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * اضافه کردن درگاه «snappay» به enum ستون gateway جدول payments.
 *
 * این مایگریشن عمداً محافظه‌کار است:
 * - اگر جدول payments وجود نداشته باشد (نصب تازه‌ای که اسکیمای آن با
 *   synchronize ساخته می‌شود) کاری نمی‌کند.
 * - اگر مقدار snappay از قبل در enum باشد (محیطی که synchronize آن را
 *   ساخته) دوباره ALTER نمی‌زند.
 * - در down فقط وقتی مقدار snappay حذف می‌شود که هیچ پرداختی با این
 *   درگاه ثبت نشده باشد؛ وگرنه خطا می‌دهد تا داده‌ای سکوتاً خراب نشود.
 */
export class AddSnappayGateway1794000000000 implements MigrationInterface {
  private async getGatewayColumnType(q: QueryRunner): Promise<string | null> {
    const rows: { COLUMN_TYPE: string }[] = await q.query(
      `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'payments'
         AND COLUMN_NAME = 'gateway'`,
    );

    return rows?.[0]?.COLUMN_TYPE ?? null;
  }

  async up(q: QueryRunner): Promise<void> {
    const columnType = await this.getGatewayColumnType(q);

    if (!columnType || columnType.includes("'snappay'")) {
      return;
    }

    await q.query(
      `ALTER TABLE payments
       MODIFY COLUMN gateway ENUM('mellat','zarinpal','digipay','tara','snappay') NOT NULL`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    const columnType = await this.getGatewayColumnType(q);

    if (!columnType || !columnType.includes("'snappay'")) {
      return;
    }

    const rows: { count: number }[] = await q.query(
      `SELECT COUNT(*) AS count FROM payments WHERE gateway = 'snappay'`,
    );

    if (Number(rows?.[0]?.count ?? 0) > 0) {
      throw new Error(
        'امکان حذف مقدار snappay از enum درگاه وجود ندارد: پرداخت اسنپ‌پی ثبت شده است',
      );
    }

    await q.query(
      `ALTER TABLE payments
       MODIFY COLUMN gateway ENUM('mellat','zarinpal','digipay','tara') NOT NULL`,
    );
  }
}
