import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { reportRange } from './report-range';
import { ReportsQuery } from './reports.dto';

// One qualifying order, never one row per payment. Payment records are in rial;
// orders and wallet transactions are in toman. A successful gateway must cover
// the outstanding amount and a wallet debit must exist for its share.
const paid = `o.status IN ('paid','shipped','delivered') AND (
 o.finalPrice = 0 OR (
 (o.walletPayment <= 0 OR EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.transactionKey=CONCAT('wallet-order-',o.id) AND w.type='purchase' AND w.status='success' AND w.amount>=o.walletPayment))
 AND (o.finalPrice <= o.walletPayment OR EXISTS (SELECT 1 FROM payments pay WHERE pay.orderId=o.id AND pay.purpose='order' AND pay.status='success' AND pay.amount >= ROUND((o.finalPrice-o.walletPayment)*10)))
 ))`;
// `LINES` is reserved by MySQL; use a non-keyword CTE name for line-item data.
const base = `WITH cohort AS (SELECT o.*, (${paid}) AS eligible FROM \`order\` o WHERE o.created_at >= ? AND o.created_at < ?),
 report_lines AS (SELECT v.product_id AS productId, v.id AS variantId, i.order_id AS orderId, i.quantity AS quantity,
 CASE WHEN (o.totalPrice-o.saleDiscount)>0 THEN i.totalPrice * GREATEST(o.totalPrice-o.discount,0)/(o.totalPrice-o.saleDiscount) ELSE 0 END AS revenue
 FROM cohort o JOIN order_item i ON i.order_id=o.id LEFT JOIN variant v ON v.id=i.variant_id WHERE o.eligible=1),
 product_sales AS (SELECT productId, SUM(quantity) units, SUM(revenue) revenue, COUNT(DISTINCT orderId) orders FROM report_lines WHERE productId IS NOT NULL GROUP BY productId),
 product_stock AS (SELECT product_id productId, SUM(GREATEST(stock,0)) stock FROM variant GROUP BY product_id)`;

type Kind = 'sales' | 'products' | 'categories' | 'variants';
const isKind = (kind: string): kind is Kind =>
  ['sales', 'products', 'categories', 'variants'].includes(kind);
const sorts: Record<Kind, Record<string, string>> = {
  sales: {
    date: 'r.createdAt',
    units: 'r.createdAt',
    name: 'r.name',
    revenue: 'r.revenue',
    gross: 'r.gross',
    discount: 'r.discount',
  },
  products: {
    name: 'r.name',
    units: 'r.units',
    revenue: 'r.revenue',
    orders: 'r.orders',
    stock: 'r.stock',
  },
  categories: {
    name: 'r.name',
    units: 'r.units',
    revenue: 'r.revenue',
    orders: 'r.orders',
    stock: 'r.activeProducts',
  },
  variants: {
    name: 'r.name',
    units: 'r.units',
    revenue: 'r.revenue',
    orders: 'r.orders',
    stock: 'r.stock',
  },
};

@Injectable()
export class ReportsService {
  constructor(private readonly db: DataSource) {}
  private meta(q: ReportsQuery) {
    if (q.start < '1900-01-01')
      throw new BadRequestException('تاریخ باید از سال ۱۹۰۰ به بعد باشد');
    const range = reportRange(q.start, q.end);
    return {
      ...range,
      timezone: 'Asia/Tehran',
      currency: 'IRT',
      generatedAt: new Date().toISOString(),
    };
  }
  private async summaryFor(from: string, to: string) {
    const [row] = await this.db.query(
      `${base} SELECT COUNT(*) registered, COALESCE(SUM(eligible),0) paidOrders,
   COALESCE(SUM(status='cancelled'),0) cancelled, COALESCE(SUM(CASE WHEN eligible THEN totalPrice ELSE 0 END),0) gross,
   COALESCE(SUM(CASE WHEN eligible THEN discount ELSE 0 END),0) discounts,
   COALESCE(SUM(CASE WHEN eligible THEN GREATEST(totalPrice-discount,0) ELSE 0 END),0) bookedSales
   FROM cohort`,
      [from, to],
    );
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value)]),
    );
  }
  async summary(q: ReportsQuery) {
    const m = this.meta(q);
    const previous = reportRange(m.previousStart, m.previousEnd);
    const [current, prior, statuses, daily, missing, orderQuality] =
      await Promise.all([
        this.summaryFor(m.from, m.to),
        this.summaryFor(previous.from, previous.to),
        this.db.query(
          `${base} SELECT status, COUNT(*) count FROM cohort GROUP BY status ORDER BY status`,
          [m.from, m.to],
        ),
        // Generate a range-joined civil-day calendar; supports Tehran's historic DST.
        this.db.query(
          `${base}, calendar AS (${m.days.map(() => 'SELECT ? AS day, ? AS start_at, ? AS end_at').join(' UNION ALL ')})
       SELECT cal.day, COUNT(c.id) registered, COALESCE(SUM(c.eligible),0) paidOrders,
       COALESCE(SUM(CASE WHEN c.eligible THEN GREATEST(c.totalPrice-c.discount,0) ELSE 0 END),0) bookedSales
       FROM calendar cal LEFT JOIN cohort c ON c.created_at >= cal.start_at AND c.created_at < cal.end_at GROUP BY cal.day ORDER BY cal.day`,
          [m.from, m.to, ...m.days.flatMap(d => [d.day, d.from, d.to])],
        ),
        this.db.query(
          `${base} SELECT COUNT(*) count FROM report_lines WHERE productId IS NULL`,
          [m.from, m.to],
        ),
        this.db.query(
          `${base} SELECT COUNT(*) count FROM cohort o WHERE o.eligible = 1 AND (
        NOT EXISTS (SELECT 1 FROM order_item i WHERE i.order_id=o.id) OR
        ABS(COALESCE((SELECT SUM(i.totalPrice) FROM order_item i WHERE i.order_id=o.id),0) - (o.totalPrice-o.saleDiscount)) > 0.01
      )`,
          [m.from, m.to],
        ),
      ]);
    return {
      meta: m,
      current: {
        ...current,
        netSales: null,
        refunds: null,
        average: current.paidOrders
          ? current.bookedSales / current.paidOrders
          : null,
      },
      previous: {
        ...prior,
        netSales: null,
        refunds: null,
        average: prior.paidOrders ? prior.bookedSales / prior.paidOrders : null,
      },
      statuses,
      daily,
      missingProductLines: Number(missing[0]?.count ?? 0),
      inconsistentOrders: Number(orderQuality[0]?.count ?? 0),
    };
  }
  async interest(q: ReportsQuery) {
    const meta = this.meta(q);
    const args = [meta.from, meta.to];
    const prefix = `WITH events AS (SELECT name, session, product, category FROM analytics_events WHERE created_at >= ? AND created_at < ?),
      sessions AS (SELECT session, MAX(name='checkout_started') checkout, MAX(name='purchase_success') purchase FROM events GROUP BY session)`;
    const [products, categories, coverage] = await Promise.all([
      this.db.query(
        `${prefix} SELECT p.id, p.title name,
        SUM(e.name='product_view') views, SUM(e.name='add_to_cart') adds,
        COUNT(DISTINCT CASE WHEN e.name='product_view' THEN e.session END) viewSessions,
        COUNT(DISTINCT CASE WHEN e.name='product_view' AND s.checkout=1 THEN e.session END) checkoutSessions,
        COUNT(DISTINCT CASE WHEN e.name='product_view' AND s.purchase=1 THEN e.session END) purchaseSessions
        FROM events e JOIN product p ON p.id=e.product JOIN sessions s ON s.session=e.session
        WHERE e.name IN ('product_view','add_to_cart') GROUP BY p.id,p.title ORDER BY views DESC, p.id LIMIT 20`,
        args,
      ),
      this.db.query(
        `${prefix}, category_events AS (
        SELECT e.session,e.category categoryId,e.name FROM events e WHERE e.name='category_view' AND e.category IS NOT NULL
        UNION ALL SELECT e.session,pc.category_id categoryId,e.name FROM events e JOIN product_categories pc ON pc.product_id=e.product WHERE e.name='add_to_cart')
        SELECT c.id,c.name, SUM(e.name='category_view') views, SUM(e.name='add_to_cart') adds,
        COUNT(DISTINCT CASE WHEN e.name='category_view' THEN e.session END) viewSessions,
        COUNT(DISTINCT CASE WHEN e.name='category_view' AND s.checkout=1 THEN e.session END) checkoutSessions,
        COUNT(DISTINCT CASE WHEN e.name='category_view' AND s.purchase=1 THEN e.session END) purchaseSessions
        FROM category_events e JOIN category c ON c.id=e.categoryId JOIN sessions s ON s.session=e.session
        GROUP BY c.id,c.name ORDER BY views DESC,c.id LIMIT 20`,
        args,
      ),
      this.db.query(
        `SELECT name, DATE_FORMAT(MIN(created_at), '%Y-%m-%dT%H:%i:%s.000Z') earliest FROM analytics_events WHERE name IN ('category_view','product_view') GROUP BY name`,
      ),
    ]);
    return { meta, products, categories, coverage };
  }
  private tableSql(kind: Kind, q: ReportsQuery) {
    const r = reportRange(q.start, q.end);
    const search = `%${q.search.replace(/[\\%_]/g, '\\$&')}%`;
    let body = '';
    if (kind === 'sales')
      body = `SELECT o.id, o.orderNumber name, DATE_FORMAT(o.created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt, o.status, o.totalPrice gross, o.discount, GREATEST(o.totalPrice-o.discount,0) revenue FROM cohort o WHERE o.eligible=1 AND o.orderNumber LIKE ?`;
    else if (kind === 'products')
      body = `SELECT p.id, p.title AS name, COALESCE(ps.units,0) units, COALESCE(ps.revenue,0) revenue, COALESCE(ps.orders,0) orders, COALESCE(st.stock,0) stock FROM product p LEFT JOIN product_sales ps ON ps.productId=p.id LEFT JOIN product_stock st ON st.productId=p.id WHERE p.title LIKE ?`;
    else if (kind === 'variants')
      body = `SELECT v.id, CONCAT(p.title, ' / ', COALESCE(col.name,''), ' / ', COALESCE(sz.name,'')) name, COALESCE(s.units,0) units, COALESCE(s.revenue,0) revenue, COALESCE(s.orders,0) orders, v.stock stock FROM variant v JOIN product p ON p.id=v.product_id LEFT JOIN color col ON col.id=v.color_id LEFT JOIN size sz ON sz.id=v.size_id LEFT JOIN (SELECT variantId, SUM(quantity) units, SUM(revenue) revenue, COUNT(DISTINCT orderId) orders FROM report_lines WHERE variantId IS NOT NULL GROUP BY variantId) s ON s.variantId=v.id WHERE p.title LIKE ?`;
    // Aggregate order count separately to avoid multiplying a category's revenue by its orders.
    if (kind === 'categories')
      body = `SELECT c.id,c.name, COALESCE(SUM(ps.units),0) units, COALESCE(SUM(ps.revenue),0) revenue, COUNT(DISTINCT CASE WHEN st.stock>0 THEN p.id END) activeProducts, (SELECT COUNT(DISTINCT l.orderId) FROM report_lines l JOIN product_categories cc ON cc.product_id=l.productId WHERE cc.category_id=c.id) orders FROM category c LEFT JOIN product_categories pc ON pc.category_id=c.id LEFT JOIN product p ON p.id=pc.product_id LEFT JOIN product_sales ps ON ps.productId=p.id LEFT JOIN product_stock st ON st.productId=p.id WHERE c.isActive=1 AND c.name LIKE ? GROUP BY c.id,c.name`;
    return {
      sql: `${base}, result AS (${body})`,
      params: [r.from, r.to, search],
    };
  }
  async table(kindValue: string, q: ReportsQuery) {
    if (!isKind(kindValue)) throw new BadRequestException();
    const kind = kindValue;
    const { sql, params } = this.tableSql(kind, q);
    const sort = sorts[kind][q.sort];
    if (!sort) throw new BadRequestException('مرتب‌سازی نامعتبر');
    const order = q.direction === 'asc' ? 'ASC' : 'DESC';
    const [rows, count] = await Promise.all([
      this.db.query(
        `${sql} SELECT * FROM result r ORDER BY ${sort} ${order}, r.id ASC LIMIT ? OFFSET ?`,
        [...params, q.limit, (q.page - 1) * q.limit],
      ),
      this.db.query(`${sql} SELECT COUNT(*) total FROM result`, params),
    ]);
    return {
      meta: this.meta(q),
      rows,
      pagination: {
        page: q.page,
        limit: q.limit,
        total: Number(count[0].total),
      },
    };
  }
  async csv(
    kindValue: string,
    q: ReportsQuery,
    response: import('express').Response,
  ) {
    if (!isKind(kindValue)) throw new BadRequestException();
    const kind = kindValue,
      { sql, params } = this.tableSql(kind, q);
    const sort = sorts[kind][q.sort];
    if (!sort) throw new BadRequestException('مرتب‌سازی نامعتبر');
    const order = q.direction === 'asc' ? 'ASC' : 'DESC';
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const stream = await runner.stream(
        `${sql} SELECT * FROM result r ORDER BY ${sort} ${order}, r.id ASC`,
        params,
      );
      response.status(200).set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${kind}-report.csv"`,
        'Cache-Control': 'no-store',
      });
      const fields =
        kind === 'sales'
          ? [
              'id',
              'name',
              'createdAt',
              'status',
              'gross',
              'discount',
              'revenue',
            ]
          : kind === 'categories'
            ? ['id', 'name', 'units', 'revenue', 'orders', 'activeProducts']
            : ['id', 'name', 'units', 'revenue', 'orders', 'stock'];
      response.write(
        '\uFEFF' +
          fields
            .map(field =>
              ['revenue', 'gross', 'discount'].includes(field)
                ? `${field}_toman`
                : field,
            )
            .join(',') +
          '\r\n',
      );
      const escape = (value: unknown) => {
        let text =
          value == null
            ? ''
            : typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
              ? String(value)
              : '';
        if (/^[\s]*[=+@\-\t\r]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
      };
      const stop = () => stream.destroy();
      response.once('close', stop);
      try {
        for await (const row of stream) {
          if (response.destroyed) break;
          if (
            !response.write(
              fields.map(key => escape(row[key])).join(',') + '\r\n',
            )
          ) {
            await new Promise<void>((resolve, reject) => {
              const onDrain = () => {
                response.off('close', onClose);
                resolve();
              };
              const onClose = () => {
                response.off('drain', onDrain);
                reject(new Error('Client disconnected'));
              };
              response.once('drain', onDrain);
              response.once('close', onClose);
              if (response.destroyed) onClose();
            });
          }
        }
        if (!response.destroyed) response.end();
      } finally {
        response.off('close', stop);
      }
    } finally {
      await runner.release();
    }
  }
}
