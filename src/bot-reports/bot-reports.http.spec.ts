import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ResponseInterceptor } from 'src/common/interceptors/response.interceptor';
import request from 'supertest';

import {
  BOT_REPORTS_READER,
  BotReportsReader,
  SalesSummary,
} from './bot-reports.contract';
import { BotReportsController } from './bot-reports.controller';
import { BotServiceKeyGuard } from './bot-service-key.guard';

/**
 * تست یکپارچهٔ HTTP برای API گزارش‌های ربات بله.
 *
 * نکتهٔ حیاتی که اینجا سنجیده می‌شود: پاسخ باید «خام» و دقیقاً هم‌شکل
 * قرارداد باشد (`@RawResponse`)، نه داخل پاکت عمومی `{ status, message, data }`
 * که ResponseInterceptor برای بقیهٔ سایت می‌سازد؛ وگرنه ربات بله پاسخ را
 * نمی‌شناسد. reader ماک است چون این تست لایهٔ HTTP/گارد را می‌سنجد، نه کوئری‌ها.
 */
describe('Bot reports HTTP API', () => {
  let app: INestApplication;
  let configuredToken: string | undefined;

  const salesSummary: SalesSummary = {
    from: '2026-10-21',
    to: '2026-10-21',
    timezone: 'Asia/Tehran',
    currency: 'IRT',
    paidOrders: 3,
    grossSales: 1500000,
    refunds: 0,
    netSales: 1500000,
    averageOrderValue: 500000,
    generatedAt: '2026-10-21T08:00:00.000Z',
  };

  const reader: BotReportsReader = {
    getSalesSummary: jest.fn(() => Promise.resolve(salesSummary)),
    getCustomerSummary: jest.fn(() =>
      Promise.resolve({ newCustomers: 4, repeatCustomers: 1 }),
    ),
    getLowStock: jest.fn(({ threshold }) =>
      Promise.resolve({ threshold, inventorySyncedAt: null, items: [] }),
    ),
    getOrder: jest.fn(() => Promise.resolve(null)),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BotReportsController],
      providers: [
        BotServiceKeyGuard,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'ZOPPINI_BOT_SERVICE_TOKEN' ? configuredToken : undefined,
            ),
          },
        },
        { provide: BOT_REPORTS_READER, useValue: reader },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    configuredToken = 'test-service-token';
    jest.clearAllMocks();
  });

  const salesUrl = '/api/bot/v1/reports/sales?from=2026-10-21&to=2026-10-21';

  it('بدون توکنِ تنظیم‌شده روی سرور 503 می‌دهد (fail-closed)', async () => {
    configuredToken = undefined;

    await request(app.getHttpServer())
      .get(salesUrl)
      .set('Authorization', 'Bearer anything')
      .expect(503);
  });

  it('بدون هدر Authorization یا با توکن اشتباه 401 می‌دهد', async () => {
    await request(app.getHttpServer()).get(salesUrl).expect(401);

    await request(app.getHttpServer())
      .get(salesUrl)
      .set('Authorization', 'Bearer wrong-service-token')
      .expect(401);
  });

  it('با توکن درست، پاسخ خام قرارداد برمی‌گردد (بدون پاکت data)', async () => {
    const response = await request(app.getHttpServer())
      .get(salesUrl)
      .set('Authorization', 'Bearer test-service-token')
      .expect(200);

    expect(response.body).toEqual(salesSummary);
    expect(response.body).not.toHaveProperty('data');
  });

  it('بازهٔ تاریخ نامعتبر 400 می‌دهد', async () => {
    await request(app.getHttpServer())
      .get('/api/bot/v1/reports/sales?from=2026-02-30&to=2026-03-01')
      .set('Authorization', 'Bearer test-service-token')
      .expect(400);
  });

  it('سفارش پیدا‌نشده پاسخ ۲۰۰ با notFound می‌دهد', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/bot/v1/orders/ORD-9999')
      .set('Authorization', 'Bearer test-service-token')
      .expect(200);

    expect(response.body).toEqual({ orderNumber: 'ORD-9999', notFound: true });
  });
});
