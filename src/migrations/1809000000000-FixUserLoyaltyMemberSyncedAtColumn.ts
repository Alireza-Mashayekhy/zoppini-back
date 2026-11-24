import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * اصلاح ستون جاافتادهٔ `user.loyalty_member_synced_at` در محیط‌هایی که نسخهٔ
 * اولیهٔ `1808000000000-RahkaranReconciliationAndLoyaltyTracking` روی آن‌ها
 * اجرا شده بود.
 *
 * علت ریشه‌ای:
 * Entity `User` با `@Entity()` بدون نام صریح تعریف شده و نام جدول واقعی آن در
 * MySQL مفرد (`user`) است. نسخهٔ اولیهٔ مایگریشن `1808000000000` به اشتباه
 * وجود جدول `users` را بررسی می‌کرد؛ در نتیجه در Production که جدول `users`
 * وجود ندارد، مایگریشن بدون خطا رد و در جدول `migrations` ثبت می‌شد ولی ستون
 * `loyalty_member_synced_at` روی جدول `user` ساخته نمی‌شد و تمام کوئری‌های
 * احراز هویت (`POST /api/auth/login` و `POST /api/auth/sign-up`) هنگام اجرای
 * `usersService.findWithPhone` با خطای MySQL `ER_BAD_FIELD_ERROR` و HTTP 500
 * مواجه می‌شدند.
 *
 * چون `1808000000000` قبلاً در جدول `migrations` دیتابیس‌های مستقر ثبت شده،
 * یک مایگریشن جدید، فقط‌افزودنی و idempotent لازم است تا ستون روی جدول واقعی
 * `user` اضافه شود.
 */
export class FixUserLoyaltyMemberSyncedAtColumn1809000000000 implements MigrationInterface {
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
    if (!(await this.tableExists(queryRunner, 'user'))) {
      return;
    }

    if (!(await this.columnExists(queryRunner, 'user', 'rahkaranId'))) {
      await queryRunner.query(
        'ALTER TABLE `user` ADD COLUMN `rahkaranId` INT NULL',
      );
    }

    if (
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
      (await this.tableExists(queryRunner, 'user')) &&
      (await this.columnExists(queryRunner, 'user', 'loyalty_member_synced_at'))
    ) {
      await queryRunner.query(
        'ALTER TABLE `user` DROP COLUMN `loyalty_member_synced_at`',
      );
    }
  }
}
