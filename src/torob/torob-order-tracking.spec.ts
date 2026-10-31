import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createHmac, generateKeyPairSync, sign } from 'crypto';
import { ResponseInterceptor } from 'src/common/interceptors/response.interceptor';
import { Order } from 'src/order/entities/order.entity';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';

import { verifyAttribution } from './torob-attribution.util';
import { TorobOrderGuard } from './torob-order.guard';
import { TorobOrderTrackingController } from './torob-order-tracking.controller';
import {
  parseTrackingQuery,
  TorobOrderTrackingService,
} from './torob-order-tracking.service';

const secret = 'a-test-only-secret-with-at-least-32-characters';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const createJwt = (payload: object) => {
  const head = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', typ: 'JWT', v: 1 }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
};
const createAttribution = (body: object) => {
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
};

describe('Torob order tracking', () => {
  let app: INestApplication;
  let qb: any;
  let transactions: jest.Mock;
  const now = () => Math.floor(Date.now() / 1000);
  const validJwt = () =>
    createJwt({ aud: 'shop.test', exp: now() + 60, nbf: now() - 1 });
  const path =
    '/api/torob/v1/orders?purchase_timestamp_gt=2025-01-01T00:00:00.000000Z&limit=10';
  const doGet = () =>
    request(app.getHttpServer()).get(path).set('Host', 'shop.test');

  beforeAll(async () => {
    process.env.TOROB_PUBLIC_KEY = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    process.env.TOROB_TRACKING_HOST = 'shop.test';
    process.env.TOROB_ATTRIBUTION_SECRET = secret;
    qb = {};
    for (const method of [
      'select',
      'innerJoin',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'limit',
    ])
      qb[method] = jest.fn().mockReturnValue(qb);
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    transactions = jest.fn(callback =>
      Promise.resolve(callback({ query: jest.fn().mockResolvedValue([]) })),
    );
    const service = new TorobOrderTrackingService(
      { createQueryBuilder: () => qb } as unknown as Repository<Order>,
      { transaction: transactions } as unknown as DataSource,
    );
    const module = await Test.createTestingModule({
      controllers: [TorobOrderTrackingController],
      providers: [
        TorobOrderGuard,
        { provide: TorobOrderTrackingService, useValue: service },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    await app.init();
  });
  beforeEach(() => {
    process.env.TOROB_TRACKING_ENABLED = 'true';
    qb.getRawMany.mockResolvedValue([]);
  });
  afterAll(async () => {
    await app.close();
    delete process.env.TOROB_PUBLIC_KEY;
    delete process.env.TOROB_TRACKING_ENABLED;
    delete process.env.TOROB_TRACKING_HOST;
    delete process.env.TOROB_ATTRIBUTION_SECRET;
  });

  it('is disabled by default even when token authentication is otherwise valid', async () => {
    delete process.env.TOROB_TRACKING_ENABLED;
    await doGet()
      .set('X-Torob-Token', validJwt())
      .set('X-Torob-Token-Version', '1')
      .expect(403);
  });
  it('rejects missing, expired, early, incorrect host, forged or wrong-version tokens', async () => {
    await doGet().expect(401);
    for (const token of [
      createJwt({ aud: 'other.test', exp: now() + 60, nbf: now() - 1 }),
      createJwt({ aud: 'shop.test', exp: now() - 1, nbf: now() - 60 }),
      createJwt({ aud: 'shop.test', exp: now() + 60, nbf: now() + 1 }),
      validJwt() + 'x',
    ]) {
      await doGet()
        .set('X-Torob-Token', token)
        .set('X-Torob-Token-Version', '1')
        .expect(401);
    }
    await doGet()
      .set('X-Torob-Token', validJwt())
      .set('X-Torob-Token-Version', '2')
      .expect(401);
    await request(app.getHttpServer())
      .get(path)
      .set('Host', 'other.test')
      .set('X-Torob-Token', validJwt())
      .set('X-Torob-Token-Version', '1')
      .expect(401);
  });
  it('returns unwrapped data, sorted and scoped to active attributed paid purchases', async () => {
    qb.getRawMany.mockResolvedValueOnce([
      {
        purchase_utc: '2025-01-01T01:02:03.123456Z',
        updated_utc: '2025-01-01T02:02:03.123456Z',
        clid: 'click-1',
        status: 'cancelled',
        total: '1000.00',
        discount: '100.00',
        shipping: '20.00',
      },
    ]);
    const response = await doGet()
      .set('X-Torob-Token', validJwt())
      .set('X-Torob-Token-Version', '1')
      .expect(200);
    expect(response.body).toEqual({
      success: true,
      data: [
        {
          purchase_timestamp: '2025-01-01T01:02:03.123456Z',
          last_updated_timestamp: '2025-01-01T02:02:03.123456Z',
          torob_clid: 'click-1',
          status: 'cancelled',
          order_value: 900,
          shipping_amount: 20,
        },
      ],
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(qb.innerJoin).toHaveBeenCalledWith(
      'torob_attribution_grants',
      'g',
      expect.stringContaining('g.active = 1'),
    );
    expect(qb.andWhere).toHaveBeenCalledWith('o.created_at > :after', {
      after: '2025-01-01 00:00:00.000000',
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('o.torob_was_paid = 1'),
      expect.anything(),
    );
    expect(qb.orderBy).toHaveBeenCalledWith('o.created_at', 'ASC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('o.id', 'ASC');
    const empty = await doGet()
      .set('X-Torob-Token', validJwt())
      .set('X-Torob-Token-Version', '1')
      .expect(200);
    expect(empty.body).toEqual({ success: true, data: [] });
  });
  it('validates the exact UTC timestamp and bounded limit', () => {
    expect(parseTrackingQuery('2025-01-01T01:02:03.123456Z', '1000')).toEqual({
      after: '2025-01-01 01:02:03.123456',
      limit: 1000,
    });
    for (const pair of [
      ['2025-02-30T00:00:00Z', '1'],
      ['2025-01-01T00:00:00+03:30', '1'],
      ['2025-01-01T00:00:00Z', '1001'],
      ['2025-01-01T00:00:00Z', '0'],
    ])
      expect(() => parseTrackingQuery(...(pair as [string, string]))).toThrow();
  });
  it('checks signed attribution purpose, clid, grant and the 168-hour window', () => {
    const time = Date.now();
    const body = {
      purpose: 'torob-click',
      grantId: '11111111-1111-4111-8111-111111111111',
      clid: 'click-1',
      clickedAt: time,
    };
    expect(verifyAttribution(createAttribution(body), secret, time)).toEqual(
      body,
    );
    expect(
      verifyAttribution(
        createAttribution({ ...body, clickedAt: time - 7 * 86400000 }),
        secret,
        time,
      ),
    ).toBeNull();
    expect(
      verifyAttribution(
        createAttribution({ ...body, clickedAt: time + 1 }),
        secret,
        time,
      ),
    ).toBeNull();
    expect(
      verifyAttribution(
        createAttribution({ ...body, clid: '<script>' }),
        secret,
        time,
      ),
    ).toBeNull();
    expect(
      verifyAttribution(createAttribution(body) + 'x', secret, time),
    ).toBeNull();
  });
  it('guards internal grant registration and revocation', async () => {
    await request(app.getHttpServer())
      .post('/api/torob/internal/attribution')
      .send({
        action: 'revoke',
        grantId: '11111111-1111-4111-8111-111111111111',
      })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/torob/internal/attribution')
      .set('x-torob-internal-secret', secret)
      .send({
        action: 'revoke',
        grantId: '11111111-1111-4111-8111-111111111111',
      })
      .expect(201);
    expect(transactions).toHaveBeenCalled();
  });
});
