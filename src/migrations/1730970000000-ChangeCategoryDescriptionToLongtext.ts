import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChangeCategoryDescriptionToLongtext1730970000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE category
      MODIFY COLUMN description LONGTEXT NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE category
      MODIFY COLUMN description VARCHAR(255) NOT NULL
    `);
  }
}
