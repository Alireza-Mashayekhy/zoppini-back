import { MigrationInterface, QueryRunner } from 'typeorm';

/** TypeORM can explicitly write CURRENT_TIMESTAMP without fractional seconds on updates.
 * A trigger ensures even those writes, as well as raw SQL updates, retain precision.
 */
export class OrderUpdatedAtPrecision1800000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // On fresh development databases synchronize creates the table later.
    if (!(await q.hasTable('order'))) return;
    await q.query(
      'ALTER TABLE `order` MODIFY `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)',
    );
    // Safe to retry if a previous attempt failed after creating the trigger.
    await q.query('DROP TRIGGER IF EXISTS `order_set_updated_at_precision`');
    await q.query(
      'CREATE TRIGGER `order_set_updated_at_precision` BEFORE UPDATE ON `order` FOR EACH ROW SET NEW.`updated_at` = CURRENT_TIMESTAMP(6)',
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TRIGGER IF EXISTS `order_set_updated_at_precision`');
    // Keep the higher-precision column to avoid discarding stored timestamps.
  }
}
