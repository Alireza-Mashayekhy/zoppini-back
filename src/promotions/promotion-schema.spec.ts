import initSqlJs from 'sql.js';
import { DataSource, getMetadataArgsStorage } from 'typeorm';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

import { PromotionSystem1802000000000 } from '../migrations/1802000000000-PromotionSystem';
import { CartDiscountEligibility1807000000000 } from '../migrations/1807000000000-CartDiscountEligibility';
import { Promotion } from './entities/promotion.entity';

class MetadataDataSource extends DataSource {
  async prepareMetadata() {
    await this.buildMetadatas();
  }
}

describe('promotion production schema compatibility', () => {
  it('can SELECT every mapped promotion column from the migration schema', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: (sql: string, params?: unknown[]) => {
        if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
          // promotions بعد از ثبت CREATE آن موجود در نظر گرفته می‌شود
          const table = params?.[0];
          const exists =
            table === 'promotions' &&
            statements.some(s => s.includes('CREATE TABLE `promotions`'));
          return Promise.resolve([{ COUNT: exists ? 1 : 0 }]);
        }

        if (sql.includes('INFORMATION_SCHEMA'))
          return Promise.resolve([{ COUNT: 0 }]);
        statements.push(sql);
        return Promise.resolve([]);
      },
    } as never;

    await new PromotionSystem1802000000000().up(fakeRunner);
    await new CartDiscountEligibility1807000000000().up(fakeRunner);
    const createTable = statements.find(sql =>
      sql.includes('CREATE TABLE `promotions`'),
    )!;
    const columns = [...createTable.matchAll(/^\s*`([^`]+)`\s+/gm)].map(
      match => match[1],
    );

    /*
     * ستون‌های اضافه‌شده با ALTER TABLE ... ADD COLUMN در مایگریشن‌های بعدی
     * را هم به فهرست ستون‌های نهایی اضافه می‌کنیم؛ production همین‌طور
     * ساخته می‌شود.
     */
    for (const statement of statements) {
      const alter = statement.match(
        /ALTER TABLE `promotions` ADD COLUMN `([^`]+)`/,
      );

      if (alter && !columns.includes(alter[1])) {
        columns.push(alter[1]);
      }
    }
    expect(columns.length).toBeGreaterThan(40);

    // Build genuine MySQL ORM metadata without connecting to a production database.
    const source = new MetadataDataSource({
      type: 'mysql',
      database: 'test',
      entities: getMetadataArgsStorage()
        .tables.map(table => table.target)
        .filter(
          (target): target is new (...args: never[]) => object =>
            typeof target === 'function',
        ),
    });
    await source.prepareMetadata();
    const metadata = source.getMetadata(Promotion);
    expect(
      metadata.columns
        .map(column => column.databaseName)
        .filter(name => !columns.includes(name)),
    ).toEqual([]);

    // Execute the generated SELECT, not a mocked repository. SQLite is used only
    // to verify column existence; the SELECT comes from the MySQL query builder.
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    try {
      db.run(
        `CREATE TABLE promotions (${columns.map(name => `\`${name}\` TEXT`).join(', ')})`,
      );
      const sql = source
        .getRepository(Promotion)
        .createQueryBuilder('promotion')
        .getSql();
      expect(() => db.exec(sql)).not.toThrow();
    } finally {
      db.close();
    }
  });

  /*
   * سندِ خودِ مشکل: پیش از اجرای 1807000000000، جدول promotions دو ستونی
   * را ندارد که entity همیشه در SELECT می‌آورد؛ نتیجه در production
   * «Unknown column ... in 'field list'» و خطای ۵۰۰ روی فهرست/ساخت
   * پروموشن است. پس ثبت آن مایگریشن در config اجباری است.
   */
  it('shows the two cart-discount columns only arrive with migration 1807', async () => {
    const statements: string[] = [];
    const fakeRunner = {
      query: (sql: string, params?: unknown[]) => {
        if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
          const table = params?.[0];
          const exists =
            table === 'promotions' &&
            statements.some(s => s.includes('CREATE TABLE `promotions`'));
          return Promise.resolve([{ COUNT: exists ? 1 : 0 }]);
        }
        if (sql.includes('INFORMATION_SCHEMA'))
          return Promise.resolve([{ COUNT: 0 }]);
        statements.push(sql);
        return Promise.resolve([]);
      },
    } as never;

    await new PromotionSystem1802000000000().up(fakeRunner);

    const createTable = statements.find(sql =>
      sql.includes('CREATE TABLE `promotions`'),
    )!;
    const columns = [...createTable.matchAll(/^\s*`([^`]+)`\s+/gm)].map(
      match => match[1],
    );

    for (const required of ['applyToDiscountedProducts', 'cartDiscountBase']) {
      expect(columns).not.toContain(required);
      expect(
        getMetadataArgsStorage().columns.some(
          column =>
            column.target === Promotion &&
            (column.options.name ?? column.propertyName) === required,
        ),
      ).toBe(true);
    }

    await new CartDiscountEligibility1807000000000().up(fakeRunner);
    const altered = statements
      .map(sql => sql.match(/ALTER TABLE `promotions` ADD COLUMN `([^`]+)`/))
      .filter(Boolean)
      .map(match => match![1]);

    expect(altered).toEqual(
      expect.arrayContaining(['applyToDiscountedProducts', 'cartDiscountBase']),
    );
  });
});
