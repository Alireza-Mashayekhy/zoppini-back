import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  AnalyticsAdminController,
  PrivacyController,
} from './analytics.controller';
import { AnalyticsService } from './analytics.service';

describe('analytics HTTP authorization and strict DTOs', () => {
  let app: INestApplication;
  const jwt = new JwtService();
  const report = jest.fn().mockResolvedValue({ visitors: 0 });
  const event = jest.fn().mockResolvedValue({ saved: true });
  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = 'test-only-jwt-not-a-real-secret';
    const module = await Test.createTestingModule({
      controllers: [AnalyticsAdminController, PrivacyController],
      providers: [
        { provide: JwtService, useValue: jwt },
        {
          provide: AnalyticsService,
          useValue: {
            report,
            event,
            trusted: (key: string) => {
              if (key !== 'test-proxy') throw new Error();
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  const path = '/admin/analytics/overview?start=2026-10-27&end=2026-10-27';
  const cookie = (roles: string[]) =>
    `access_token=${jwt.sign({ id: 1, roles }, { secret: process.env.JWT_ACCESS_SECRET })}`;
  it('requires a verified admin session', async () => {
    await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer())
      .get(path)
      .set('Cookie', 'access_token=invalid')
      .expect(401);
    await request(app.getHttpServer())
      .get(path)
      .set('Cookie', cookie(['user']))
      .expect(403);
    await request(app.getHttpServer())
      .get(path)
      .set('Cookie', cookie(['seo']))
      .expect(403);
    await request(app.getHttpServer())
      .get(path)
      .set('Cookie', cookie(['admin']))
      .expect(200);
  });
  it('rejects unvalidated filters even for admin', async () => {
    await request(app.getHttpServer())
      .get(path + '&limit=100000')
      .set('Cookie', cookie(['admin']))
      .expect(400);
    await request(app.getHttpServer())
      .get(path + '&phone=redacted')
      .set('Cookie', cookie(['admin']))
      .expect(400);
  });
  it('does not expose purchase or accept arbitrary visitor claims publicly', async () => {
    for (const body of [
      { name: 'purchase_success' },
      { name: 'page_view', visitor: 'untrusted' },
    ]) {
      await request(app.getHttpServer())
        .post('/privacy/event')
        .set('x-privacy-proxy', 'test-proxy')
        .send({
          id: '11111111-1111-4111-8111-111111111111',
          device: 'mobile',
          ...body,
        })
        .expect(400);
    }
    expect(event).not.toHaveBeenCalled();
  });
});
