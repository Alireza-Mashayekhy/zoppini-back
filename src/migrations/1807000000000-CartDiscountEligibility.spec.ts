import { getMetadataArgsStorage } from 'typeorm';

import { OrderItem } from 'src/order/entities/order-item';
import { Promotion } from 'src/promotions/entities/promotion.entity';

import { CartDiscountEligibility1807000000000 } from './1807000000000-CartDiscountEligibility';

/**
 * مایگریشن صلاحیت تخفیف سبد: ستون‌های تازه باید دقیقاً همان‌هایی باشند که
 * entity ها نقشه‌برداری می‌کنند؛ وگرنه در production خطای
 * «Unknown column» می‌گیریم.
 */

function recordingQueryRunner(
  existing: {
    tables?: string[];
    columns?: Record<string, string[]>;
  } = {},
) {
  const queries: string[] = [];

  const runner = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.includes('INFORMATION_SCHEMA.TABLES')) {
        const table = String(params?.[0] ?? '');

        return [{ COUNT: (existing.tables ?? []).includes(table) ? 1 : 0 }];
      }

      if (normalized.includes('INFORMATION_SCHEMA.COLUMNS')) {
        const [table, column] = (params ?? []).map(String);
        const known = existing.columns?.[table] ?? [];

        return [{ COUNT: known.includes(column) ? 1 : 0 }];
      }

      queries.push(normalized);

      return [];
    }),
    hasTable: jest.fn().mockResolvedValue(true),
    hasColumn: jest.fn().mockResolvedValue(false),
  } as never;

  return { runner, queries };
}

function entityColumnNames(target: Function): string[] {
  return getMetadataArgsStorage()
    .columns.filter(column => column.target === target)
    .map(column => column.options.name ?? (column.propertyName as string));
}

describe('cart-discount eligibility migration', () => {
  it('adds the two promotion columns that the entity maps', async () => {
    const { runner, queries } = recordingQueryRunner({
      tables: ['promotions', 'order_item'],
    });

    await new CartDiscountEligibility1807000000000().up(runner);

    const promotionsAlters = queries.filter(sql =>
      sql.startsWith('ALTER TABLE `promotions`'),
    );

    const added = promotionsAlters
      .map(
        sql =>
          sql.match(/ALTER TABLE `promotions` ADD COLUMN `([^`]+)`/)?.[1] ??
          null,
      )
      .filter(Boolean) as string[];

    const entityColumns = entityColumnNames(Promotion);

    /* نام ستون در entity باید دقیقاً همان نام دیتابیس باشد (camelCase) */
    expect(entityColumns).toContain('applyToDiscountedProducts');
    expect(entityColumns).toContain('cartDiscountBase');
    expect(added).toContain('applyToDiscountedProducts');
    expect(added).toContain('cartDiscountBase');
  });

  it('adds sale_discount on order_item (entity: saleDiscount)', async () => {
    const { runner, queries } = recordingQueryRunner({
      tables: ['promotions', 'order_item'],
    });

    await new CartDiscountEligibility1807000000000().up(runner);

    expect(entityColumnNames(OrderItem)).toContain('sale_discount');
    expect(
      queries.some(sql =>
        sql.includes('ALTER TABLE `order_item` ADD COLUMN `sale_discount`'),
      ),
    ).toBe(true);
  });

  it('is idempotent when the columns already exist', async () => {
    const { runner, queries } = recordingQueryRunner({
      tables: ['promotions', 'order_item'],
      columns: {
        promotions: ['applyToDiscountedProducts', 'cartDiscountBase'],
        order_item: ['sale_discount'],
      },
    });

    await new CartDiscountEligibility1807000000000().up(runner);

    expect(queries.filter(sql => sql.includes('ADD COLUMN'))).toHaveLength(0);
  });

  it('down() drops exactly the columns it added', async () => {
    const { runner, queries } = recordingQueryRunner({
      tables: ['promotions', 'order_item'],
      columns: {
        promotions: ['applyToDiscountedProducts', 'cartDiscountBase'],
        order_item: ['sale_discount'],
      },
    });

    await new CartDiscountEligibility1807000000000().down(runner);

    const dropped = queries
      .filter(sql => sql.includes('DROP COLUMN'))
      .map(sql => sql.match(/DROP COLUMN `([^`]+)`/)?.[1] ?? null)
      .filter(Boolean) as string[];

    expect(dropped).toContain('applyToDiscountedProducts');
    expect(dropped).toContain('cartDiscountBase');
    expect(dropped).toContain('sale_discount');
  });
});
