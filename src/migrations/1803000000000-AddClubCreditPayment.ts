import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClubCreditPayment1803000000000 implements MigrationInterface {
  private async tableExists(queryRunner: QueryRunner): Promise<boolean> {
    const rows: { COUNT: string | number }[] = await queryRunner.query(
      `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order'`,
    );
    return Number(rows?.[0]?.COUNT ?? 0) > 0;
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.tableExists(queryRunner))) {
      return;
    }

    const rows: { COUNT: string | number }[] = await queryRunner.query(
      `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order' AND COLUMN_NAME = 'club_credit_payment'`,
    );
    if (Number(rows?.[0]?.COUNT ?? 0) === 0) {
      await queryRunner.query(
        'ALTER TABLE `order` ADD COLUMN `club_credit_payment` DECIMAL(15,2) NOT NULL DEFAULT 0',
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows: { COUNT: string | number }[] = await queryRunner.query(
      `SELECT COUNT(*) AS COUNT FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order' AND COLUMN_NAME = 'club_credit_payment'`,
    );
    if (Number(rows?.[0]?.COUNT ?? 0) > 0) {
      await queryRunner.query(
        'ALTER TABLE `order` DROP COLUMN `club_credit_payment`',
      );
    }
  }
}
