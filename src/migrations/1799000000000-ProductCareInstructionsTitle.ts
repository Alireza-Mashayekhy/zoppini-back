import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/** Existing products keep the historical washing label. */
export class ProductCareInstructionsTitle1799000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // On a fresh development database synchronize creates the entity later.
    if (!(await queryRunner.hasTable('product'))) return;
    if (await queryRunner.hasColumn('product', 'careInstructionsTitle')) return;
    await queryRunner.addColumn(
      'product',
      new TableColumn({
        name: 'careInstructionsTitle',
        type: 'varchar',
        length: '20',
        isNullable: false,
        default: "'washing'",
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (
      (await queryRunner.hasTable('product')) &&
      (await queryRunner.hasColumn('product', 'careInstructionsTitle'))
    )
      await queryRunner.dropColumn('product', 'careInstructionsTitle');
  }
}
