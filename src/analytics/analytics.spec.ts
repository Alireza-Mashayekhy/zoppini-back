import {
  BadRequestException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { createHmac } from 'crypto';

import { ConsentDto, EventDto, ReportDto } from './analytics.dto';
import { AnalyticsService, POLICY } from './analytics.service';

const visitor = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
describe('privacy analytics boundaries (no database/network)', () => {
  const query = jest.fn();
  const db = { query, transaction: jest.fn(fn => fn({ query })) };
  const service = new AnalyticsService(db as never);
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (value: unknown, metatype: any) =>
    pipe.transform(value, { type: 'body', metatype });
  const token = (extra = {}) => {
    const body = Buffer.from(
      JSON.stringify({
        visitor,
        session,
        exp: Date.now() + 1800000,
        policy: POLICY,
        categories: 'necessary,preferences,analytics,marketing',
        ...extra,
      }),
    ).toString('base64url');
    return `${body}.${createHmac('sha256', process.env.PRIVACY_SIGNING_SECRET!).update(body).digest('base64url')}`;
  };
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([]);
    process.env.PRIVACY_SIGNING_SECRET =
      'test-only-signing-value-not-a-real-secret';
    process.env.PRIVACY_PROXY_SECRET =
      'test-only-proxy-value-not-a-real-secret';
  });
  it('denies absent, forged, expired and obsolete contexts', () => {
    expect(service.context('')).toBeNull();
    expect(service.context(token() + '.x')).toBeNull();
    expect(service.context(token().replace(/^./, 'X'))).toBeNull();
    expect(service.context(token({ exp: Date.now() - 1 }))).toBeNull();
    expect(service.context(token({ policy: 'obsolete' }))).toBeNull();
    expect(service.context(token({ visitor: 'arbitrary' }))).toBeNull();
  });
  it('rejects missing/wrong proxy credentials', () => {
    expect(() => service.trusted('')).toThrow(UnauthorizedException);
    expect(() => service.trusted('invalid')).toThrow(UnauthorizedException);
    expect(() =>
      service.trusted(process.env.PRIVACY_PROXY_SECRET!),
    ).not.toThrow();
  });
  it('does not ingest before consent or after revocation', async () => {
    const event = { id, name: 'page_view', device: 'mobile' } as EventDto;
    await expect(service.event(event, '')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(query).not.toHaveBeenCalled();
    await expect(service.event(event, token())).rejects.toThrow(
      UnauthorizedException,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('allows only minimum public events, no purchase, visitor ID or PII', async () => {
    await expect(
      validate({ id, name: 'purchase_success', device: 'mobile' }, EventDto),
    ).rejects.toThrow();
    await expect(
      validate(
        { id, name: 'page_view', device: 'mobile', visitor, phone: 'redacted' },
        EventDto,
      ),
    ).rejects.toThrow();
    await expect(
      validate(
        {
          id,
          name: 'page_view',
          device: 'mobile',
          referrer: 'https://example.test/?private=value',
        },
        EventDto,
      ),
    ).rejects.toThrow();
    await expect(
      validate(
        {
          id,
          name: 'page_view',
          device: 'mobile',
          source: 'private@example.test',
        },
        EventDto,
      ),
    ).rejects.toThrow();
    await expect(
      validate({ id, name: 'page_view', device: 'mobile' }, EventDto),
    ).resolves.toBeInstanceOf(EventDto);
  });
  it('drops non-allowlisted campaign data and uses deduplication', async () => {
    query.mockResolvedValueOnce([{ visitor }]).mockResolvedValueOnce({});
    await service.event(
      { id, name: 'page_view', device: 'desktop', campaign: 'unreviewed' },
      token(),
    );
    const [sql, args] = query.mock.calls[1];
    expect(sql).toContain('INSERT IGNORE');
    expect(args[0]).toBe(id);
    expect(args[2]).toBe(visitor);
    expect(args[9]).toBeNull();
    expect(args).not.toContain('unreviewed');
  });
  it('records rejection without analytics or account identifiers in ledger', async () => {
    const dto = {
      id,
      policy: POLICY,
      preferences: false,
      analytics: false,
      marketing: false,
      choice: 'reject',
      changed: false,
      withdrawn: false,
    } as ConsentDto;
    await validate(dto, ConsentDto);
    await service.consent(dto);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('privacy_choices');
    expect(query.mock.calls[0][1]).not.toContain(visitor);
  });
  it('revokes grants and pending checkout without linking ledger to visitor', async () => {
    await service.consent({
      id,
      policy: POLICY,
      preferences: false,
      analytics: false,
      marketing: false,
      choice: 'reject',
      changed: true,
      withdrawn: true,
      oldVisitor: visitor,
    });
    expect(query.mock.calls[0][1]).not.toContain(visitor);
    expect(query.mock.calls[1][0]).toContain('active = false');
    expect(query.mock.calls[2][0]).toContain('DELETE FROM analytics_checkout');
  });
  it('rejects contradictory consent choices', async () => {
    await expect(
      service.consent({
        id,
        policy: POLICY,
        preferences: false,
        analytics: true,
        marketing: false,
        choice: 'reject',
        changed: false,
        withdrawn: false,
      }),
    ).rejects.toThrow(BadRequestException);
  });
  it('validates real dates, range limit and Tehran day boundaries', async () => {
    expect(
      service.range({ start: '2026-10-27', end: '2026-10-27' } as ReportDto),
    ).toEqual(['2026-10-26 20:30:00.000', '2026-10-27 20:30:00.000']);
    for (const q of [
      { start: '2026-02-30', end: '2026-03-02' },
      { start: '2026-10-28', end: '2026-10-27' },
      { start: '2020-01-01', end: '2026-10-27' },
    ])
      expect(() => service.range(q as ReportDto)).toThrow();
    await expect(
      validate({ start: 'x', end: 'y' }, ReportDto),
    ).rejects.toThrow();
  });
  it('purchase is server-only, idempotent and canonical, bounded to grant', async () => {
    await service.purchase({ query } as never, 123);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('INSERT IGNORE');
    expect(sql).toContain("CONCAT('purchase:',o.id)");
    expect(sql).not.toContain('revenue');
    expect(sql).toContain("o.status='paid'");
    expect(sql).toContain('g.active=true');
    expect(sql).toContain('c.expires_at>UTC_TIMESTAMP(3)');
  });
  it('financial overview reads canonical active orders rather than browser amounts', async () => {
    query
      .mockResolvedValueOnce([{ visitors: 0 }])
      .mockResolvedValueOnce([{ revenue: 0, aov: 0 }]);
    await service.report('overview', {
      start: '2026-10-27',
      end: '2026-10-27',
    } as ReportDto);
    expect(query.mock.calls[1][0]).toContain('SUM(o.finalPrice)');
    expect(query.mock.calls[1][0]).toContain(
      "o.status IN ('paid','shipped','delivered')",
    );
    expect(query.mock.calls[1][0]).not.toMatch(/user|password|nationalCode/i);
  });
  it('keeps product cohort and filter values parameterized in every report', async () => {
    await service.report('products', {
      start: '2026-10-27',
      end: '2026-10-27',
      product: 42,
      source: 'google',
    } as ReportDto);
    for (const [sql, args] of query.mock.calls) {
      expect((sql.match(/\?/g) || []).length).toBe(args.length);
      expect(sql).toContain('ae.visitor IN');
      expect(sql).not.toContain('42');
      expect(sql).not.toContain('pv.e.');
      expect(sql).toContain('v.product_id');
      expect(sql).not.toContain('v.productId');
    }
  });
  it('rejects invalid report name and limits journey; never joins User', async () => {
    const q = {
      start: '2026-10-27',
      end: '2026-10-27',
      visitor,
      limit: 100,
    } as ReportDto;
    await expect(service.report('arbitrary', q)).rejects.toThrow();
    await service.report('journey', q);
    expect(query.mock.calls[0][0]).not.toMatch(/user|password|nationalCode/i);
    expect(query.mock.calls[0][1].slice(-2)).toEqual([visitor, 100]);
  });
});
