import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/** Extend the existing enum without dropping any values present in this database. */
export class AddHediehMallPickup1797000000000 implements MigrationInterface {
  private async column(q: QueryRunner): Promise<TableColumn | null> {
    const table = await q.getTable('order');
    const column = table?.findColumnByName('shippingMethod');
    // Fresh installs: migrations run before synchronize, so `order` may not
    // exist yet. The ShippingMethod enum already contains 'pickup', hence
    // synchronize creates the final schema and there is nothing to change.
    if (!column || column.type !== 'enum' || !column.enum?.length) return null;
    return column;
  }

  async up(q: QueryRunner): Promise<void> {
    const column = await this.column(q);
    if (!column || column.enum!.includes('pickup')) return;
    const updated = column.clone();
    updated.enum = [...column.enum!, 'pickup'];
    await q.changeColumn('order', column, updated);
  }

  async down(q: QueryRunner): Promise<void> {
    const column = await this.column(q);
    if (!column || !column.enum!.includes('pickup')) return;
    const rows: { count: number }[] = await q.query(
      "SELECT COUNT(*) AS count FROM `order` WHERE `shippingMethod` = 'pickup'",
    );
    if (Number(rows[0]?.count ?? 0) > 0) {
      throw new Error('Cannot remove pickup: pickup orders exist');
    }
    const updated = column.clone();
    updated.enum = column.enum!.filter(value => value !== 'pickup');
    await q.changeColumn('order', column, updated);
  }
}
