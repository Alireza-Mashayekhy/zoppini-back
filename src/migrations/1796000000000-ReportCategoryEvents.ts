import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
  TableIndex,
} from 'typeorm';
export class ReportCategoryEvents1796000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!(await q.hasTable('analytics_events')))
      throw new Error('analytics_events is missing');
    if (!(await q.hasColumn('analytics_events', 'category')))
      await q.addColumn(
        'analytics_events',
        new TableColumn({ name: 'category', type: 'int', isNullable: true }),
      );
    const table = await q.getTable('analytics_events');
    if (!table?.indices.some(i => i.name === 'IDX_analytics_category_date'))
      await q.createIndex(
        'analytics_events',
        new TableIndex({
          name: 'IDX_analytics_category_date',
          columnNames: ['category', 'created_at'],
        }),
      );
    const order = await q.getTable('order');
    if (
      order &&
      !order.indices.some(i => i.name === 'IDX_order_reports_created')
    )
      await q.createIndex(
        'order',
        new TableIndex({
          name: 'IDX_order_reports_created',
          columnNames: ['created_at', 'status'],
        }),
      );
    const payments = await q.getTable('payments');
    if (
      payments &&
      !payments.indices.some(i => i.name === 'IDX_payments_reports_order')
    )
      await q.createIndex(
        'payments',
        new TableIndex({
          name: 'IDX_payments_reports_order',
          columnNames: ['orderId', 'purpose', 'status'],
        }),
      );
  }
  async down(q: QueryRunner): Promise<void> {
    for (const [table, name] of [
      ['analytics_events', 'IDX_analytics_category_date'],
      ['order', 'IDX_order_reports_created'],
      ['payments', 'IDX_payments_reports_order'],
    ]) {
      const t = await q.getTable(table);
      if (t?.indices.some(i => i.name === name)) await q.dropIndex(table, name);
    }
    if (await q.hasColumn('analytics_events', 'category'))
      await q.dropColumn('analytics_events', 'category');
  }
}
