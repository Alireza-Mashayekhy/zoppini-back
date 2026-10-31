import { MigrationInterface, QueryRunner } from 'typeorm';

export class CookieAnalytics1793059200000 implements MigrationInterface {
  // IF NOT EXISTS keeps the migration idempotent (same pattern as
  // CreateBotManagementTables): databases where these tables already exist
  // without a migrations-table record must not crash `migration:run` before
  // later migrations (e.g. the analytics_events.category column) can apply.
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS privacy_choices (
      id char(36) PRIMARY KEY, policy varchar(32) NOT NULL, categories json NOT NULL,
      choice varchar(16) NOT NULL, changed boolean NOT NULL, withdrawn boolean NOT NULL,
      created_at datetime(3) NOT NULL, INDEX(created_at))`);
    await q.query(`CREATE TABLE IF NOT EXISTS analytics_grants (
      visitor char(36) PRIMARY KEY, active boolean NOT NULL, expires_at datetime(3) NOT NULL)`);
    await q.query(`CREATE TABLE IF NOT EXISTS analytics_events (
      id varchar(64) PRIMARY KEY, name varchar(32) NOT NULL, visitor char(36) NOT NULL,
      session char(36) NOT NULL, created_at datetime(3) NOT NULL,
      product int NULL, variant int NULL, source varchar(64) NULL, medium varchar(64) NULL,
      campaign varchar(64) NULL, referrer varchar(253) NULL, device varchar(8) NOT NULL,
      order_id int NULL UNIQUE,
      INDEX(created_at, name), INDEX(visitor, created_at))`);
    await q.query(`CREATE TABLE IF NOT EXISTS analytics_checkout (
      order_id int PRIMARY KEY, visitor char(36) NOT NULL, session char(36) NOT NULL,
      expires_at datetime(3) NOT NULL,
      source varchar(64) NULL, medium varchar(64) NULL, campaign varchar(64) NULL,
      referrer varchar(253) NULL, device varchar(8) NOT NULL)`);
  }
  async down(q: QueryRunner): Promise<void> {
    for (const table of [
      'analytics_checkout',
      'analytics_events',
      'analytics_grants',
      'privacy_choices',
    ])
      await q.query(`DROP TABLE IF EXISTS ${table}`);
  }
}
