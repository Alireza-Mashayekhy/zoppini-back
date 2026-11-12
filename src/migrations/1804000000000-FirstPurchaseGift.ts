import { MigrationInterface, QueryRunner } from 'typeorm';

export class FirstPurchaseGift1804000000000 implements MigrationInterface {
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
    if (
      !(await this.tableExists(queryRunner, 'first_purchase_gift_settings'))
    ) {
      await queryRunner.query(`
        CREATE TABLE \`first_purchase_gift_settings\` (
          \`id\` TINYINT UNSIGNED NOT NULL,
          \`is_active\` TINYINT NOT NULL DEFAULT 1,
          \`discount_percent\` DECIMAL(5,2) NOT NULL DEFAULT 15.00,
          \`title\` VARCHAR(150) NOT NULL DEFAULT 'هدیه اولین خرید',
          \`description\` TEXT NOT NULL,
          \`starts_at\` DATETIME NULL,
          \`ends_at\` DATETIME NULL,
          \`popup_enabled\` TINYINT NOT NULL DEFAULT 1,
          \`announcement_enabled\` TINYINT NOT NULL DEFAULT 1,
          \`popup_frequency\` ENUM('session','daily','always') NOT NULL DEFAULT 'session',
          \`stack_with_discount_codes\` TINYINT NOT NULL DEFAULT 0,
          \`stack_with_sale_prices\` TINYINT NOT NULL DEFAULT 0,
          \`created_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          \`updated_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    }

    await queryRunner.query(`
      INSERT INTO \`first_purchase_gift_settings\`
        (\`id\`, \`is_active\`, \`discount_percent\`, \`title\`, \`description\`,
         \`popup_enabled\`, \`announcement_enabled\`, \`popup_frequency\`, \`stack_with_discount_codes\`, \`stack_with_sale_prices\`)
      VALUES
        (1, 1, 15, 'هدیه اولین خرید',
         'این هدیه اختصاصی برای اولین خرید شما از وب‌سایت زوپینی در نظر گرفته شده است.',
         1, 1, 'session', 0, 0)
      ON DUPLICATE KEY UPDATE \`id\` = VALUES(\`id\`)
    `);

    if (!(await this.tableExists(queryRunner, 'first_purchase_gift_claims'))) {
      await queryRunner.query(`
        CREATE TABLE \`first_purchase_gift_claims\` (
          \`id\` INT NOT NULL AUTO_INCREMENT,
          \`user_id\` INT NOT NULL,
          \`order_id\` INT NOT NULL,
          \`status\` ENUM('reserved','redeemed','released') NOT NULL,
          \`discount_percent\` DECIMAL(5,2) NOT NULL,
          \`discount_amount\` DECIMAL(15,2) NOT NULL,
          \`reserved_until\` DATETIME NULL,
          \`redeemed_at\` DATETIME NULL,
          \`created_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          \`updated_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`UQ_first_purchase_gift_claim_user\` (\`user_id\`),
          UNIQUE KEY \`UQ_first_purchase_gift_claim_order\` (\`order_id\`),
          KEY \`IDX_first_purchase_gift_claim_status\` (\`status\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    }

    if (
      (await this.tableExists(queryRunner, 'order')) &&
      !(await this.columnExists(
        queryRunner,
        'order',
        'first_purchase_gift_discount',
      ))
    ) {
      await queryRunner.query(
        'ALTER TABLE `order` ADD COLUMN `first_purchase_gift_discount` DECIMAL(15,2) NOT NULL DEFAULT 0',
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.tableExists(queryRunner, 'order')) {
      if (
        await this.columnExists(
          queryRunner,
          'order',
          'first_purchase_gift_discount',
        )
      ) {
        await queryRunner.query(
          'ALTER TABLE `order` DROP COLUMN `first_purchase_gift_discount`',
        );
      }
    }
    if (await this.tableExists(queryRunner, 'first_purchase_gift_claims')) {
      await queryRunner.query('DROP TABLE `first_purchase_gift_claims`');
    }
    if (await this.tableExists(queryRunner, 'first_purchase_gift_settings')) {
      await queryRunner.query('DROP TABLE `first_purchase_gift_settings`');
    }
  }
}
