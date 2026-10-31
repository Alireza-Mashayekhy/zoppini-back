import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import initSqlJs, { Database } from 'sql.js';
import { PassThrough, Readable } from 'stream';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { reportRange } from './report-range';
import { ReportsController } from './reports.controller';
import { ReportsQuery } from './reports.dto';
import { ReportsService } from './reports.service';

describe('sales reports on safe transaction fixtures', () => {
  let sqlite: Database;
  let service: ReportsService;
  const query = Object.assign(new ReportsQuery(), {
    start: '2026-10-30',
    end: '2026-10-31',
    page: 1,
    limit: 20,
  });
  beforeAll(async () => {
    const SQL = await initSqlJs();
    sqlite = new SQL.Database();
    sqlite.create_function(
      'CONCAT',
      (a: unknown, b: unknown) => String(a) + String(b),
    );
    sqlite.create_function('GREATEST', (a: number, b: number) =>
      Math.max(a, b),
    );
    sqlite.run(`CREATE TABLE "order" (id INTEGER PRIMARY KEY, status TEXT, created_at TEXT, finalPrice REAL, walletPayment REAL, totalPrice REAL, saleDiscount REAL, discount REAL);
      CREATE TABLE payments (orderId INT, purpose TEXT, status TEXT, amount REAL);
      CREATE TABLE wallet_transactions (transactionKey TEXT, type TEXT, status TEXT, amount REAL);
      CREATE TABLE order_item (id INT, order_id INT, variant_id INT, quantity INT, totalPrice REAL);
      CREATE TABLE variant (id INT, product_id INT, color_id INT, size_id INT, stock INT);
      CREATE TABLE product (id INT, title TEXT);
      CREATE TABLE category (id INT, name TEXT, isActive INT);
      CREATE TABLE product_categories (product_id INT, category_id INT);
      CREATE TABLE color (id INT, name TEXT); CREATE TABLE size (id INT, name TEXT);`);
    // One paid order, one failed/pending, one cancelled despite an earlier successful payment,
    // and one paid order with a simulated partial-refund ambiguity (no unified refund ledger).
    sqlite.run(`INSERT INTO "order" VALUES
      (1,'paid','2026-10-30 12:00:00',950,0,1000,100,200),
      (2,'pending','2026-10-30 13:00:00',1000,0,1000,0,0),
      (3,'cancelled','2026-10-30 14:00:00',1000,0,1000,0,0),
      (4,'shipped','2026-10-31 12:00:00',500,0,500,0,0),
      (5,'paid','2026-10-31 13:00:00',100,0,100,0,0),
      (6,'paid','2026-10-29 20:29:59',100,0,100,0,0);
      INSERT INTO payments VALUES (1,'order','success',9500),(1,'order','failed',9500),(2,'order','failed',10000),(3,'order','success',10000),(4,'order','success',5000),(5,'order','failed',1000),(6,'order','success',1000);
      INSERT INTO product VALUES (1,'Product A'),(2,'Product B'),(3,'Product C');
      INSERT INTO variant VALUES (1,1,1,1,5),(2,2,1,1,0),(3,3,1,1,3);
      INSERT INTO color VALUES (1,'Colour'); INSERT INTO size VALUES (1,'Size');
      INSERT INTO category VALUES (1,'Category A',1),(2,'Category B',1);
      INSERT INTO product_categories VALUES (1,1),(2,1),(1,2);
      INSERT INTO order_item VALUES (1,1,1,2,540),(2,1,2,1,360),(3,2,1,1,1000),(4,3,1,1,1000),(5,4,1,1,500),(6,5,1,1,100),(7,6,1,1,100);`);
    sqlite.run('ALTER TABLE "order" ADD COLUMN orderNumber TEXT');
    sqlite.run('UPDATE "order" SET orderNumber = \'ORD-\' || id');
    const db = {
      query: (sql: string, args: unknown[]) => {
        sql = sql.replace(
          "DATE_FORMAT(o.created_at,'%Y-%m-%dT%H:%i:%s.%fZ')",
          'o.created_at',
        );
        sql = sql.replace(
          "CONCAT(p.title, ' / ', COALESCE(col.name,''), ' / ', COALESCE(sz.name,''))",
          "(p.title || ' / ' || COALESCE(col.name,'') || ' / ' || COALESCE(sz.name,''))",
        );
        const statement = sqlite.prepare(sql);
        statement.bind(args as never[]);
        const rows: unknown[] = [];
        while (statement.step()) rows.push(statement.getAsObject());
        statement.free();
        return Promise.resolve(rows);
      },
    };
    service = new ReportsService(db as unknown as DataSource);
  });
  afterAll(() => sqlite.close());

  it('uses Tehran civil day boundaries and a previous equal-length range', () => {
    const r = reportRange('2026-10-30', '2026-10-31');
    expect(r.from).toBe('2026-10-29 20:30:00.000');
    expect(r.to).toBe('2026-10-31 20:30:00.000');
    expect(r.previousStart).toBe('2026-10-28');
    expect(r.previousEnd).toBe('2026-10-29');
    const dst = reportRange('2022-03-22', '2022-03-22');
    expect(
      Date.parse(dst.to.replace(' ', 'T') + 'Z') -
        Date.parse(dst.from.replace(' ', 'T') + 'Z'),
    ).toBe(23 * 3600000);
    expect(() => reportRange('2026-02-30', '2026-03-01')).toThrow();
    expect(() => reportRange('2024-01-01', '2026-01-01')).toThrow();
  });
  it('excludes failed, unpaid and cancelled orders without multiplying retries, and leaves unknown refunds unknown', async () => {
    const result = await service.summary(query);
    expect(result.current).toMatchObject({
      registered: 5,
      paidOrders: 2,
      cancelled: 1,
      gross: 1500,
      discounts: 200,
      bookedSales: 1300,
      netSales: null,
      refunds: null,
      average: 650,
    });
    expect(result.daily.map((r: any) => Number(r.bookedSales))).toEqual([
      800, 500,
    ]);
    expect(result.daily.map((r: any) => Number(r.paidOrders))).toEqual([1, 1]);
  });
  it('requires wallet debit and gateway proof for mixed payments and includes wallet-only orders', async () => {
    sqlite.run(`INSERT INTO "order" VALUES
      (10,'paid','2026-10-30 15:00:00',200,200,200,0,0,'ORD-10'),
      (11,'paid','2026-10-30 15:00:00',300,100,300,0,0,'ORD-11'),
      (12,'paid','2026-10-30 15:00:00',200,200,200,0,0,'ORD-12');
      INSERT INTO wallet_transactions VALUES ('wallet-order-10','purchase','success',200),('wallet-order-11','purchase','success',100);
      INSERT INTO payments VALUES (11,'order','success',2000),(12,'order','success',2000);
      INSERT INTO order_item VALUES (10,10,1,1,200),(11,11,1,1,300),(12,12,1,1,200);`);
    try {
      const result = await service.summary(query);
      expect(result.current.paidOrders).toBe(4);
      expect(result.current.bookedSales).toBe(1300 + 500); // existing 1300 plus these 500
    } finally {
      sqlite.run(
        `DELETE FROM order_item WHERE id IN (10,11,12); DELETE FROM payments WHERE orderId IN (10,11,12); DELETE FROM wallet_transactions; DELETE FROM "order" WHERE id IN (10,11,12);`,
      );
    }
  });
  it('filters and paginates eligible sales without exposing customer data', async () => {
    const q = Object.assign(new ReportsQuery(), query, {
      search: 'ORD-1',
      sort: 'date',
      limit: 1,
    });
    const result = await service.table('sales', q);
    expect(result.pagination.total).toBe(1);
    expect(result.rows[0]).toMatchObject({
      name: 'ORD-1',
      gross: 1000,
      discount: 200,
      revenue: 800,
    });
    expect(Object.keys(result.rows[0])).not.toContain('user');
    await expect(
      service.table(
        'products',
        Object.assign(new ReportsQuery(), query, { sort: 'date' }),
      ),
    ).rejects.toThrow();
  });
  it('aggregates real line quantities and proportional coupon discount; low sellers include zero sales', async () => {
    const high = await service.table('products', query);
    expect(
      high.rows.map((r: any) => [
        r.id,
        r.units,
        Math.round(r.revenue),
        r.orders,
      ]),
    ).toEqual([
      [1, 3, 980, 2],
      [2, 1, 320, 1],
      [3, 0, 0, 0],
    ]);
    const low = await service.table(
      'products',
      Object.assign(new ReportsQuery(), query, { direction: 'asc', limit: 1 }),
    );
    expect(low.rows[0]).toMatchObject({ id: 3, units: 0, stock: 3 });
    expect(low.pagination.total).toBe(3);
    const cats = await service.table('categories', query);
    expect(cats.rows.find((r: any) => r.id === 1)).toMatchObject({
      units: 4,
      revenue: 1300,
      orders: 2,
      activeProducts: 1,
    });
    const variants = await service.table('variants', query);
    expect(variants.rows[0]).toMatchObject({ id: 1, units: 3, stock: 5 });
  });
});

describe('report API authorization and CSV', () => {
  it('streams all filtered rows, not only the requested page, and escapes spreadsheet formulas', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
      name: index === 0 ? '=HYPERLINK("bad")' : `product ${index}`,
      units: 1,
      revenue: 20,
      orders: 1,
      stock: 5,
    }));
    const runner = {
      connect: jest.fn(),
      release: jest.fn(),
      stream: jest.fn().mockResolvedValue(Readable.from(rows)),
    };
    const service = new ReportsService({
      createQueryRunner: () => runner,
    } as unknown as DataSource);
    const res = new PassThrough() as any;
    res.status = () => res;
    res.set = () => res;
    let csv = '';
    res.on('data', (chunk: Buffer) => {
      csv += chunk.toString('utf8');
    });
    const q = Object.assign(new ReportsQuery(), {
      start: '2026-10-30',
      end: '2026-10-31',
      page: 2,
      limit: 10,
      search: 'product',
    });
    await service.csv('products', q, res);
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(26);
    expect(csv).toContain('"\'=HYPERLINK');
    expect(csv).toContain('revenue_toman');
    expect(runner.stream.mock.calls[0][0]).not.toMatch(/\bLIMIT\b/i);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
  it('releases the connection when the client disconnects under backpressure', async () => {
    const source = Readable.from(
      Array.from({ length: 100 }, (_, id) => ({
        id,
        name: 'x',
        units: 1,
        revenue: 2,
        orders: 1,
        stock: 1,
      })),
    );
    const runner = {
      connect: jest.fn(),
      release: jest.fn(),
      stream: jest.fn().mockResolvedValue(source),
    };
    const service = new ReportsService({
      createQueryRunner: () => runner,
    } as unknown as DataSource);
    const res = new PassThrough() as any;
    res.status = () => res;
    res.set = () => res;
    let writes = 0;
    res.write = () => {
      if (++writes === 1) return true;
      setImmediate(() => res.destroy());
      return false;
    };
    const q = Object.assign(new ReportsQuery(), {
      start: '2026-10-30',
      end: '2026-10-31',
    });
    await expect(service.csv('products', q, res)).rejects.toThrow(
      'Client disconnected',
    );
    expect(source.destroyed).toBe(true);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
  it('restricts endpoints to admin and rejects unknown sorting input', async () => {
    const oldSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'test-only-secret-for-reports';
    const summary = jest.fn().mockResolvedValue({ current: {} });
    const csv = jest.fn((_kind, _query, response) => {
      response.status(200).send('csv');
    });
    const module = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        JwtService,
        { provide: ReportsService, useValue: { summary, csv } },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.use(cookieParser());
    await app.init();
    const jwt = new JwtService();
    const token = (roles: string[]) =>
      `access_token=${jwt.sign({ id: 1, roles }, { secret: process.env.JWT_ACCESS_SECRET })}`;
    const path = '/admin/reports/summary?start=2026-10-30&end=2026-10-31';
    try {
      await request(app.getHttpServer()).get(path).expect(401);
      await request(app.getHttpServer())
        .get(path)
        .set('Cookie', token(['seo']))
        .expect(403);
      await request(app.getHttpServer())
        .get(path + '&sort=bad')
        .set('Cookie', token(['admin']))
        .expect(400);
      await request(app.getHttpServer())
        .get(path)
        .set('Cookie', token(['admin']))
        .expect(200);
      expect(summary).toHaveBeenCalledTimes(1);
      await request(app.getHttpServer())
        .get(
          '/admin/reports/export/sales?start=2026-10-30&end=2026-10-31&search=ORD-1&sort=date',
        )
        .set('Cookie', token(['admin']))
        .expect(200);
      expect(csv).toHaveBeenCalledWith(
        'sales',
        expect.objectContaining({ search: 'ORD-1', sort: 'date' }),
        expect.anything(),
      );
    } finally {
      await app.close();
      if (oldSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = oldSecret;
    }
  });
});
