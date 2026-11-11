import initSqlJs from 'sql.js';
import { DataSource, getMetadataArgsStorage } from 'typeorm';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

import { PromotionSystem1802000000000 } from '../migrations/1802000000000-PromotionSystem';
import { Promotion } from './entities/promotion.entity';

class MetadataDataSource extends DataSource {
  async prepareMetadata() {
    await this.buildMetadatas();
  }
}

describe('promotion production schema compatibility', () => {
  it('can SELECT every mapped promotion column from the migration schema', async () => {
    const statements: string[] = [];
    await new PromotionSystem1802000000000().up({
      query: (sql: string) => {
        if (sql.includes('INFORMATION_SCHEMA'))
          return Promise.resolve([{ COUNT: 0 }]);
        statements.push(sql);
        return Promise.resolve([]);
      },
    } as never);
    const createTable = statements.find(sql =>
      sql.includes('CREATE TABLE `promotions`'),
    )!;
    const columns = [...createTable.matchAll(/^\s*`([^`]+)`\s+/gm)].map(
      match => match[1],
    );
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
});
