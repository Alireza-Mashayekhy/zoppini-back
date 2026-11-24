import { QueryRunner } from 'typeorm';

import { RahkaranReconciliationAndLoyaltyTracking1808000000000 } from './1808000000000-RahkaranReconciliationAndLoyaltyTracking';

/**
 * مایگریشن فقط افزودنی است: هر ستون پیش از ADD با INFORMATION_SCHEMA
 * بررسی می‌شود تا اجرای دوباره (یا محیطی که ستون را دستی دارد) نشکند.
 */
describe('RahkaranReconciliationAndLoyaltyTracking migration', () => {
  function runner(options: { tables?: number; columns?: number } = {}) {
    const query = jest.fn((sql: string) => {
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
        return Promise.resolve([{ COUNT: options.tables ?? 1 }]);
      }

      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return Promise.resolve([{ COUNT: options.columns ?? 0 }]);
      }

      return Promise.resolve(undefined);
    });

    return { query, q: { query } as unknown as QueryRunner };
  }

  function alterStatements(
    query: jest.Mock,
    keyword = 'ALTER TABLE',
  ): string[] {
    return query.mock.calls
      .map(call => String(call[0]))
      .filter(sql => sql.startsWith(keyword));
  }

  it('adds the reconciliation and loyalty columns when they are missing', async () => {
    const { query, q } = runner();

    await new RahkaranReconciliationAndLoyaltyTracking1808000000000().up(q);

    const statements = alterStatements(query);

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain(
      'ADD COLUMN `reconcile_required_at` DATETIME(6) NULL',
    );
    expect(statements[1]).toContain(
      'ADD COLUMN `reconcile_reason` VARCHAR(255) NULL',
    );
    expect(statements[2]).toContain(
      'ADD COLUMN `loyalty_member_synced_at` DATETIME(6) NULL',
    );
    // فقط ستون اضافه می‌شود: هیچ DROP/UPDATE/DELETE در up وجود ندارد
    expect(
      query.mock.calls
        .map(call => String(call[0]))
        .filter(sql => /DROP|DELETE|UPDATE|TRUNCATE/i.test(sql)),
    ).toHaveLength(0);
  });

  it('is idempotent when the columns already exist', async () => {
    const { query, q } = runner({ tables: 1, columns: 1 });

    await new RahkaranReconciliationAndLoyaltyTracking1808000000000().up(q);

    expect(alterStatements(query)).toHaveLength(0);
  });

  it('does not touch a table that does not exist', async () => {
    const { query, q } = runner({ tables: 0 });

    await new RahkaranReconciliationAndLoyaltyTracking1808000000000().up(q);

    expect(alterStatements(query)).toHaveLength(0);
  });

  it('drops the new columns on down()', async () => {
    const { query, q } = runner({ tables: 1, columns: 1 });

    await new RahkaranReconciliationAndLoyaltyTracking1808000000000().down(q);

    const drops = query.mock.calls
      .map(call => String(call[0]))
      .filter(sql => sql.includes('DROP COLUMN'));

    expect(drops).toHaveLength(3);
    expect(drops.join('\n')).toContain('`reconcile_required_at`');
    expect(drops.join('\n')).toContain('`reconcile_reason`');
    expect(drops.join('\n')).toContain('`loyalty_member_synced_at`');
  });

  it('skips the drop on down() when the columns are already gone', async () => {
    const { query, q } = runner({ tables: 1, columns: 0 });

    await new RahkaranReconciliationAndLoyaltyTracking1808000000000().down(q);

    expect(
      query.mock.calls
        .map(call => String(call[0]))
        .filter(sql => sql.includes('DROP COLUMN')),
    ).toHaveLength(0);
  });
});
