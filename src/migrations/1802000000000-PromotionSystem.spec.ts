import { getMetadataArgsStorage } from 'typeorm';

import { CartItem } from 'src/cart/entities/cart-item.entity';
import { Cart } from 'src/cart/entities/cart.entity';
import { OrderItem } from 'src/order/entities/order-item';
import { Order } from 'src/order/entities/order.entity';
import {
  Promotion,
  PromotionCategory,
  PromotionExcludedCategory,
  PromotionExcludedProduct,
  PromotionProduct,
  PromotionRewardCategory,
  PromotionRewardProduct,
} from 'src/promotions/entities/promotion.entity';
import {
  PromotionEvent,
  PromotionRedemption,
} from 'src/promotions/entities/promotion-redemption.entity';

import { PromotionSystem1802000000000 } from './1802000000000-PromotionSystem';

/**
 * مایگریشن در محیط توسعه با `synchronize` پوشیده می‌شود، پس یک ستون جاافتاده
 * فقط در production به چشم می‌آید. این تست ستون‌هایی که مایگریشن اضافه/می‌سازد
 * را با ستون‌های واقعی entity مقایسه می‌کند.
 */

function columnNames(target: Function): string[] {
  return getMetadataArgsStorage()
    .columns.filter(column => column.target === target)
    .map(column => column.options.name ?? (column.propertyName as string));
}

/**
 * نام جدول: `@Entity('x')` اگر داده شده باشد، وگرنه نوع‌گرا نام کلاس را
 * snake_case نمی‌کند و MariaDB/MySQL نام کلاس را همان‌طور نگه می‌دارد؛ اما
 * در این پروژه برای جدول‌های بدون نام صریح، `synchronize` نام کلاس را
 * می‌سازد. به‌همین‌دلیل در تست، فهرست جدول‌ها را صریح نگه می‌داریم.
 */
function tableName(target: Function, fallback: string): string {
  const table = getMetadataArgsStorage().tables.find(
    entry => entry.target === target,
  );

  return table?.name ?? (fallback as string);
}

/** یک QueryRunner جعلی که همهٔ جدول‌ها را موجود و همهٔ ستون‌ها را ناموجود می‌بیند */
function recordingQueryRunner(existing: {
  tables?: string[];
  columns?: Record<string, string[]>;
} = {}) {
  const queries: string[] = [];

  const runner = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.includes('INFORMATION_SCHEMA.TABLES')) {
        const table = String(params?.[0] ?? '');

        return [
          {
            COUNT: (existing.tables ?? []).includes(table) ? 1 : 0,
          },
        ];
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

describe('promotion system migration', () => {
  it('creates every promotion table with a name matching the entities', async () => {
    const { runner, queries } = recordingQueryRunner();

    await new PromotionSystem1802000000000().up(runner);

    const created = queries
      .filter(sql => sql.startsWith('CREATE TABLE'))
      .map(sql => sql.match(/CREATE TABLE `([^`]+)`/)?.[1])
      .filter(Boolean);

    const expected = [
      [Promotion, 'promotions'],
      [PromotionProduct, 'promotion_products'],
      [PromotionCategory, 'promotion_categories'],
      [PromotionExcludedProduct, 'promotion_excluded_products'],
      [PromotionExcludedCategory, 'promotion_excluded_categories'],
      [PromotionRewardProduct, 'promotion_reward_products'],
      [PromotionRewardCategory, 'promotion_reward_categories'],
      [PromotionRedemption, 'promotion_redemptions'],
      [PromotionEvent, 'promotion_events'],
    ].map(([target, fallback]) => tableName(target as Function, fallback as string));

    for (const table of expected) {
      expect(created).toContain(table);
    }
  });

  it('adds the promotion columns that the entities actually use', async () => {
    const { runner, queries } = recordingQueryRunner({
      tables: ['cart', 'cart_item', 'order', 'order_item'],
    });

    await new PromotionSystem1802000000000().up(runner);

    const added = queries
      .filter(sql => sql.startsWith('ALTER TABLE'))
      .map(sql => {
        const match = sql.match(/ALTER TABLE `([^`]+)` ADD COLUMN `([^`]+)`/);

        return match ? `${match[1]}.${match[2]}` : null;
      })
      .filter(Boolean) as string[];

    const expectedColumns: [string, string][] = [];

    for (const [target, fallback] of [
      [Cart, 'cart'],
      [CartItem, 'cart_item'],
      [Order, 'order'],
      [OrderItem, 'order_item'],
    ] as const) {
      const table = tableName(target, fallback);

      for (const column of columnNames(target)) {
        const isPromotionColumn =
          column.toLowerCase().includes('promotion') ||
          column === 'addedViaPromotion';

        if (!isPromotionColumn) {
          continue;
        }

        expectedColumns.push([table, column]);
      }
    }

    expect(expectedColumns.length).toBeGreaterThan(10);

    /*
     * تطبیق با نرمال‌سازی: نام ستون می‌تواند snake_case یا camelCase باشد
     * (`promotionDiscount` در entity)؛ مهم این است که همان ستون ساخته شود.
     */
    const normalize = (value: string) => value.replace(/_/g, '').toLowerCase();

    for (const [table, column] of expectedColumns) {
      const found = added.some(candidate => {
        const [addedTable, addedColumn] = (candidate ?? '').split('.');

        return addedTable === table && normalize(addedColumn) === normalize(column);
      });

      expect({ table, column, found }).toEqual({ table, column, found: true });
    }
  });

  it('is idempotent: a second run touches nothing when everything exists', async () => {
    const { runner, queries } = recordingQueryRunner({
      tables: [
        'promotions',
        'promotion_products',
        'promotion_categories',
        'promotion_excluded_products',
        'promotion_excluded_categories',
        'promotion_reward_products',
        'promotion_reward_categories',
        'promotion_redemptions',
        'promotion_events',
        'cart',
        'cart_item',
        'order',
        'order_item',
      ],
      columns: {
        cart: [
          'accepted_promotions',
          'dismissed_promotions',
          'selected_rewards',
          'promotion_popup_shown_for',
        ],
        cart_item: ['promotion_reward_id', 'added_via_promotion'],
        order: [
          'promotionDiscount',
          'promotion_free_item_value',
          'promotion_snapshot',
          'promotion_free_shipping',
        ],
        order_item: [
          'promotion_discount',
          'is_promotion_reward',
          'promotion_reward_id',
          'promotion_label',
          'promotion_ids',
        ],
      },
    });

    await new PromotionSystem1802000000000().up(runner);

    expect(queries).toHaveLength(0);
  });

  it('skips tables that do not exist instead of failing the deploy', async () => {
    const { runner, queries } = recordingQueryRunner({ tables: [] });

    await expect(
      new PromotionSystem1802000000000().up(runner),
    ).resolves.toBeUndefined();

    // هیچ ALTER روی جدول ناموجود اجرا نمی‌شود
    expect(queries.filter(sql => sql.startsWith('ALTER TABLE'))).toHaveLength(0);
  });

  it('drops only what it created', async () => {
    const { runner, queries } = recordingQueryRunner({
      tables: ['promotions', 'promotion_events', 'cart', 'order_item'],
      columns: {
        cart: ['accepted_promotions'],
        order_item: ['promotion_ids'],
      },
    });

    await new PromotionSystem1802000000000().down(runner);

    const droppedTables = queries
      .filter(sql => sql.startsWith('DROP TABLE'))
      .map(sql => sql.match(/DROP TABLE `([^`]+)`/)?.[1]);

    const droppedColumns = queries
      .filter(sql => sql.startsWith('ALTER TABLE'))
      .map(sql => sql.match(/DROP COLUMN `([^`]+)`/)?.[1]);

    expect(droppedTables.sort()).toEqual(['promotion_events', 'promotions']);
    expect(droppedColumns.sort()).toEqual([
      'accepted_promotions',
      'promotion_ids',
    ]);
  });
});
