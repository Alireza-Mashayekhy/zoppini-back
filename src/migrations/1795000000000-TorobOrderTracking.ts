import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableIndex,
} from 'typeorm';

export class TorobOrderTracking1795000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!(await q.hasTable('torob_attribution_grants'))) {
      await q.createTable(
        new Table({
          name: 'torob_attribution_grants',
          columns: [
            { name: 'id', type: 'varchar', length: '36', isPrimary: true },
            { name: 'active', type: 'boolean', default: true },
            { name: 'expires_at', type: 'datetime', precision: 3 },
          ],
        }),
      );
    }
    // Fresh installs: migrations run before synchronize, so `order` may not
    // exist yet. The Order entity already declares the torob columns, hence
    // synchronize creates the final schema and this migration has nothing to
    // do. Existing databases (table present) are upgraded below as before.
    if (!(await q.hasTable('order'))) return;
    for (const column of [
      new TableColumn({
        name: 'torob_clid',
        type: 'varchar',
        length: '255',
        isNullable: true,
      }),
      new TableColumn({
        name: 'torob_grant_id',
        type: 'varchar',
        length: '36',
        isNullable: true,
      }),
      new TableColumn({
        name: 'torob_was_paid',
        type: 'boolean',
        default: false,
      }),
    ])
      if (!(await q.hasColumn('order', column.name)))
        await q.addColumn('order', column);
    const table = await q.getTable('order');
    if (!table?.indices.some(index => index.name === 'IDX_order_torob_created'))
      await q.createIndex(
        'order',
        new TableIndex({
          name: 'IDX_order_torob_created',
          columnNames: ['torob_grant_id', 'created_at', 'id'],
        }),
      );
  }
  async down(q: QueryRunner): Promise<void> {
    if (await q.hasTable('order')) {
      const table = await q.getTable('order');
      if (
        table?.indices.some(index => index.name === 'IDX_order_torob_created')
      )
        await q.dropIndex('order', 'IDX_order_torob_created');
      for (const name of ['torob_clid', 'torob_grant_id', 'torob_was_paid'])
        if (await q.hasColumn('order', name)) await q.dropColumn('order', name);
    }
    if (await q.hasTable('torob_attribution_grants'))
      await q.dropTable('torob_attribution_grants');
  }
}
