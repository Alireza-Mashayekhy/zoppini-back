import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHmac, timingSafeEqual } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';

import { ConsentDto, EventDto, ReportDto } from './analytics.dto';

export const POLICY = '2026-10-31.2';
const CATEGORY_VERSION = 'necessary,preferences,analytics,marketing';
@Injectable()
export class AnalyticsService {
  constructor(private readonly db: DataSource) {}
  trusted(key: string) {
    const secret = process.env.PRIVACY_PROXY_SECRET;
    if (
      !secret ||
      secret.length < 32 ||
      typeof key !== 'string' ||
      Buffer.byteLength(key) !== Buffer.byteLength(secret) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(secret))
    )
      throw new UnauthorizedException();
  }
  context(
    token: string,
  ): { visitor: string; session: string; exp: number; policy: string } | null {
    try {
      const secret = process.env.PRIVACY_SIGNING_SECRET;
      if (!secret || secret.length < 32 || !token || token.length > 1000)
        return null;
      if (token.split('.').length !== 2) return null;
      const [body, sig] = token.split('.');
      const expected = createHmac('sha256', secret)
        .update(body)
        .digest('base64url');
      if (
        sig.length !== expected.length ||
        !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
      )
        return null;
      const c = JSON.parse(Buffer.from(body, 'base64url').toString());
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      return c.policy === POLICY &&
        c.categories === CATEGORY_VERSION &&
        c.exp > Date.now() &&
        c.exp <= Date.now() + 1800001 &&
        uuid.test(c.visitor) &&
        uuid.test(c.session)
        ? c
        : null;
    } catch {
      return null;
    }
  }
  async consent(d: ConsentDto) {
    if (
      (d.choice === 'all' && !(d.preferences && d.analytics && d.marketing)) ||
      (d.choice === 'reject' && (d.preferences || d.analytics || d.marketing))
    )
      throw new BadRequestException();
    await this.db.transaction(async m => {
      await m.query(
        'INSERT INTO privacy_choices VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))',
        [
          d.id,
          d.policy,
          JSON.stringify({
            necessary: true,
            preferences: d.preferences,
            analytics: d.analytics,
            marketing: d.marketing,
          }),
          d.choice,
          d.changed,
          d.withdrawn,
        ],
      );
      if (d.oldVisitor) {
        await m.query(
          'UPDATE analytics_grants SET active = false WHERE visitor = ?',
          [d.oldVisitor],
        );
        await m.query('DELETE FROM analytics_checkout WHERE visitor = ?', [
          d.oldVisitor,
        ]);
      }
      if (d.analytics && d.visitor)
        await m.query(
          'INSERT INTO analytics_grants VALUES (?, true, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 180 DAY)) ON DUPLICATE KEY UPDATE active = true, expires_at = VALUES(expires_at)',
          [d.visitor],
        );
    });
    return { saved: true };
  }
  async event(d: EventDto, token: string) {
    const c = this.context(token);
    if (!c) throw new UnauthorizedException();
    // Lock grant so a concurrent withdrawal cannot race ingestion.
    for (const [key, allowed] of [
      ['source', 'google,bing,instagram,telegram,direct,newsletter,torob'],
      ['medium', 'organic,cpc,social,email,referral'],
      ['campaign', process.env.ANALYTICS_CAMPAIGNS || ''],
    ] as const) {
      if (d[key] && !allowed.split(',').includes(d[key])) d[key] = undefined;
    }
    if (d.name === 'category_view') {
      if (!d.category) throw new BadRequestException();
      const categories = await this.db.query(
        'SELECT id FROM category WHERE id = ? AND isActive = 1 LIMIT 1',
        [d.category],
      );
      if (!categories.length) throw new BadRequestException();
    } else d.category = undefined;
    if (d.variant) {
      const variants = await this.db.query(
        'SELECT product_id AS productId FROM variant WHERE id=? LIMIT 1',
        [d.variant],
      );
      if (!variants.length) throw new BadRequestException();
      d.product = Number(variants[0].productId);
    }
    await this.db.transaction(async m => {
      const grants = await m.query(
        'SELECT visitor FROM analytics_grants WHERE visitor = ? AND active = true AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE',
        [c.visitor],
      );
      if (!grants.length) throw new UnauthorizedException();
      await m.query(
        `INSERT IGNORE INTO analytics_events (id,name,visitor,session,created_at,product,variant,source,medium,campaign,referrer,device,category) VALUES (?,?,?,?,UTC_TIMESTAMP(3),?,?,?,?,?,?,?,?)`,
        [
          d.id,
          d.name,
          c.visitor,
          c.session,
          d.product ?? null,
          d.variant ?? null,
          d.source ?? null,
          d.medium ?? null,
          d.campaign ?? null,
          d.referrer ?? null,
          d.device,
          d.category ?? null,
        ],
      );
    });
    return { saved: true };
  }
  async checkout(orderId: number, userId: number, token: string) {
    const c = this.context(token);
    if (!c) return;
    const [last] = await this.db.query(
      'SELECT source,medium,campaign,referrer,device FROM analytics_events WHERE visitor=? AND session=? ORDER BY created_at DESC LIMIT 1',
      [c.visitor, c.session],
    );
    await this.db.query(
      `INSERT INTO analytics_checkout (order_id, visitor, session, expires_at, source, medium, campaign, referrer, device)
      SELECT o.id, g.visitor, ?, DATE_ADD('1970-01-01 00:00:00', INTERVAL ? MICROSECOND), ?, ?, ?, ?, ? FROM \`order\` o JOIN analytics_grants g ON g.visitor = ? AND g.active = true AND g.expires_at > UTC_TIMESTAMP(3)
      WHERE o.id = ? AND o.user_id = ? AND o.status = 'pending'
      ON DUPLICATE KEY UPDATE visitor = VALUES(visitor), session = VALUES(session), expires_at = VALUES(expires_at), source=VALUES(source), medium=VALUES(medium), campaign=VALUES(campaign), referrer=VALUES(referrer), device=VALUES(device)`,
      [
        c.session,
        c.exp * 1000,
        last?.source ?? null,
        last?.medium ?? null,
        last?.campaign ?? null,
        last?.referrer ?? null,
        last?.device ?? 'unknown',
        c.visitor,
        orderId,
        userId,
      ],
    );
  }
  // Called within canonical order-paid transaction, never from the public event endpoint.
  async purchase(m: EntityManager, orderId: number) {
    await m.query(
      `INSERT IGNORE INTO analytics_events (id,name,visitor,session,created_at,device,order_id,source,medium,campaign,referrer)
      SELECT CONCAT('purchase:',o.id),'purchase_success',c.visitor,c.session,UTC_TIMESTAMP(3),c.device,o.id,c.source,c.medium,c.campaign,c.referrer
      FROM \`order\` o JOIN analytics_checkout c ON c.order_id=o.id
      JOIN analytics_grants g ON g.visitor=c.visitor AND g.active=true AND g.expires_at>UTC_TIMESTAMP(3)
      WHERE o.id=? AND o.status='paid' AND c.expires_at>UTC_TIMESTAMP(3)`,
      [orderId],
    );
    await m.query('DELETE FROM analytics_checkout WHERE order_id=?', [orderId]);
  }
  range(q: ReportDto) {
    const start = new Date(`${q.start}T00:00:00+03:30`);
    const last = new Date(`${q.end}T00:00:00+03:30`);
    if (
      !Number.isFinite(+start) ||
      !Number.isFinite(+last) ||
      new Date(`${q.start}T00:00:00Z`).toISOString().slice(0, 10) !== q.start ||
      new Date(`${q.end}T00:00:00Z`).toISOString().slice(0, 10) !== q.end ||
      +last < +start ||
      +last - +start > 365 * 86400000
    )
      throw new BadRequestException('بازه نامعتبر یا بیش از ۳۶۶ روز');
    return [
      start.toISOString().slice(0, 23).replace('T', ' '),
      new Date(+last + 86400000).toISOString().slice(0, 23).replace('T', ' '),
    ];
  }
  async report(kind: string, q: ReportDto) {
    const dates = this.range(q);
    const args: unknown[] = [...dates];
    let where = 'ae.created_at >= ? AND ae.created_at < ?';
    for (const key of ['device', 'source', 'campaign', 'product'] as const) {
      if (q[key] === undefined) continue;
      if (key === 'product') {
        // Product filtering is an explicit visitor cohort, preserving page/checkout stages.
        where += ` AND ae.visitor IN (SELECT pv.visitor FROM analytics_events pv WHERE pv.created_at>=? AND pv.created_at<? AND (pv.product=? OR pv.order_id IN (SELECT i.order_id FROM order_item i JOIN variant v ON v.id=i.variant_id WHERE v.product_id=?)))`;
        args.push(...dates, q.product, q.product);
      } else if (
        (key === 'source' || key === 'campaign') &&
        q[key] === 'Unknown'
      )
        where += ` AND ae.${key} IS NULL`;
      else {
        where += ` AND ae.${key}=?`;
        args.push(q[key]);
      }
    }
    const query = (sql: string) => this.db.query(sql, args);
    if (kind === 'consent')
      return this.db.query(
        `SELECT choice, COUNT(*) count, SUM(changed) changes, SUM(withdrawn) withdrawals FROM privacy_choices WHERE created_at >= ? AND created_at < ? GROUP BY choice`,
        dates,
      );
    if (kind === 'overview') {
      const [counts] = await query(
        `SELECT COUNT(DISTINCT visitor) visitors, COUNT(DISTINCT session) sessions, COUNT(*) events, SUM(name='page_view') pageViews, SUM(name='product_view') productViews, SUM(name='add_to_cart') adds, SUM(name='checkout_started') checkouts, SUM(name='purchase_success') purchases FROM analytics_events ae WHERE ${where}`,
      );
      const [financial] = await this.db.query(
        `SELECT COALESCE(SUM(o.finalPrice),0) revenue, COALESCE(AVG(o.finalPrice),0) aov, COUNT(*) financialOrders FROM \`order\` o JOIN (SELECT order_id FROM analytics_events ae WHERE ${where} AND name='purchase_success') e ON e.order_id=o.id WHERE o.status IN ('paid','shipped','delivered')`,
        args,
      );
      return { ...counts, ...financial };
    }
    if (kind === 'visitors')
      return query(
        `SELECT visitor,COUNT(*) events,MAX(created_at) lastSeen FROM analytics_events ae WHERE ${where} GROUP BY visitor ORDER BY lastSeen DESC LIMIT 100`,
      );
    if (kind === 'journey') {
      if (!q.visitor) throw new BadRequestException();
      return this.db.query(
        `SELECT name,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.000Z') created_at,product,variant,device FROM analytics_events ae WHERE ${where} AND visitor=? ORDER BY created_at DESC LIMIT ?`,
        [...args, q.visitor, q.limit],
      );
    }
    if (kind === 'funnel') {
      return query(`WITH filtered AS (SELECT visitor,name,created_at FROM analytics_events ae WHERE ${where}),
        s1 AS (SELECT visitor,MIN(created_at) t FROM filtered WHERE name='page_view' GROUP BY visitor),
        s2 AS (SELECT e.visitor,MIN(e.created_at) t FROM filtered e JOIN s1 ON e.visitor=s1.visitor AND e.created_at>=s1.t WHERE e.name='product_view' GROUP BY e.visitor),
        s3 AS (SELECT e.visitor,MIN(e.created_at) t FROM filtered e JOIN s2 ON e.visitor=s2.visitor AND e.created_at>=s2.t WHERE e.name='add_to_cart' GROUP BY e.visitor),
        s4 AS (SELECT e.visitor,MIN(e.created_at) t FROM filtered e JOIN s3 ON e.visitor=s3.visitor AND e.created_at>=s3.t WHERE e.name='checkout_started' GROUP BY e.visitor),
        s5 AS (SELECT e.visitor,MIN(e.created_at) t FROM filtered e JOIN s4 ON e.visitor=s4.visitor AND e.created_at>=s4.t WHERE e.name='purchase_success' GROUP BY e.visitor)
        SELECT 'page_view' name,COUNT(*) count FROM s1 UNION ALL SELECT 'product_view',COUNT(*) FROM s2 UNION ALL SELECT 'add_to_cart',COUNT(*) FROM s3 UNION ALL SELECT 'checkout_started',COUNT(*) FROM s4 UNION ALL SELECT 'purchase_success',COUNT(*) FROM s5`);
    }
    const group: Record<string, string> = {
      timeseries: 'day, name',
      funnel: 'name',
      sources: 'source, campaign',
      products: 'product',
      devices: 'device',
    };
    const select: Record<string, string> = {
      timeseries:
        "DATE_FORMAT(DATE_ADD(created_at, INTERVAL 210 MINUTE),'%Y-%m-%d') day, name, COUNT(*) count",
      funnel: 'name, COUNT(*) count, COUNT(DISTINCT visitor) visitors',
      sources:
        "COALESCE(source,'Unknown') source, COALESCE(campaign,'Unknown') campaign, COUNT(*) count",
      products:
        "product, SUM(name='product_view') views, SUM(name='add_to_cart') adds",
      devices: 'device, COUNT(*) count',
    };
    if (!Object.hasOwn(group, kind)) throw new BadRequestException();
    const rows = await query(
      `SELECT ${select[kind]} FROM analytics_events ae WHERE ${where} GROUP BY ${group[kind]} ORDER BY ${kind === 'timeseries' ? 'day' : kind === 'products' ? 'views DESC' : kind === 'funnel' ? 'name' : 'count DESC'} LIMIT 3000`,
    );
    if (kind === 'products') {
      // Only projected product/count, never customer or order entities.
      const sales = await this.db.query(
        `SELECT v.product_id product, SUM(i.quantity) bought FROM analytics_events ae JOIN order_item i ON i.order_id=ae.order_id JOIN variant v ON v.id=i.variant_id JOIN \`order\` o ON o.id=ae.order_id AND o.status IN ('paid','shipped','delivered') WHERE ae.name='purchase_success' AND ${where} GROUP BY v.product_id ORDER BY bought DESC LIMIT 100`,
        args,
      );
      return { views: rows.slice(0, 100), sales };
    }
    return rows;
  }
  @Cron('0 3 * * *')
  async retention() {
    const days = Math.max(
      1,
      Math.min(
        730,
        Math.floor(Number(process.env.ANALYTICS_RETENTION_DAYS) || 180),
      ),
    );
    for (const t of ['analytics_events', 'privacy_choices']) {
      for (let batch = 0; batch < 100; batch++) {
        const result = await this.db.query(
          `DELETE FROM ${t} WHERE created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY) LIMIT 10000`,
          [days],
        );
        if (Number(result.affectedRows) < 10000) break;
      }
    }
    await this.db.query(
      'DELETE FROM analytics_checkout WHERE expires_at < UTC_TIMESTAMP(3)',
    );
    await this.db.query(
      'DELETE FROM analytics_grants WHERE expires_at < UTC_TIMESTAMP(3)',
    );
  }
}
