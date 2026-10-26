import { randomUUID } from 'node:crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { Variant } from '../products/entities/variant.entity';
import { BotAccessService } from './bot-access.service';
import {
  BOT_ACTOR_ID_HEADER,
  BOT_CHAT_TYPE_HEADER,
  BOT_NONCE_HEADER,
  BOT_SIGNATURE_HEADER,
  BOT_TIMESTAMP_HEADER,
  computeBodySha256,
  computeBotRequestSignature,
  deriveActorSigningKey,
} from './bot-auth.util';
import { BotEventsService } from './bot-events.service';
import { BOT_REPORTS_READER } from './bot-reports.contract';
import { BotReportsController } from './bot-reports.controller';
import { BotRoleGuard } from './bot-role.guard';
import { BotServiceKeyGuard } from './bot-service-key.guard';
import { BotSettingsService } from './bot-settings.service';
import { BotInventoryAlertState } from './entities/bot-inventory-alert-state.entity';
import { BotOperator } from './entities/bot-operator.entity';
import { BotOutboxEvent } from './entities/bot-outbox-event.entity';
import { BotSetting } from './entities/bot-setting.entity';

function createMemoryEntityStore<T extends { id?: number | string }>(
  seed: T[] = [],
) {
  const rows: T[] = [...seed];
  let seq = 1;
  return {
    rows,
    create: (partial: Partial<T>) => ({ ...partial }) as T,
    save: (entity: T) => {
      if (!entity.id) entity.id = seq++;
      const idx = rows.findIndex(r => r.id === entity.id);
      if (idx >= 0) {
        rows[idx] = { ...rows[idx], ...entity };
        return Promise.resolve(rows[idx]);
      }
      rows.push(entity);
      return Promise.resolve(entity);
    },
    findOne: ({ where }: { where: Record<string, any> }) =>
      Promise.resolve(
        rows.find(r =>
          Object.entries(where).every(
            ([k, v]) => (r as Record<string, any>)[k] === v,
          ),
        ) ?? null,
      ),
    find: () => Promise.resolve([...rows]),
    count: (opts?: { where?: Record<string, any> }) => {
      if (!opts?.where) return Promise.resolve(rows.length);
      return Promise.resolve(
        rows.filter(r =>
          Object.entries(opts.where!).every(
            ([k, v]) => (r as Record<string, any>)[k] === v,
          ),
        ).length,
      );
    },
    createQueryBuilder: () => ({
      select: () => ({
        getRawOne: () =>
          Promise.resolve({ lastSyncedAt: '2026-10-26T08:00:00.000Z' }),
      }),
      where: function () {
        return this;
      },
      andWhere: function () {
        return this;
      },
      orderBy: function () {
        return this;
      },
      addOrderBy: function () {
        return this;
      },
      skip: function () {
        return this;
      },
      take: function () {
        return this;
      },
      getMany: () => Promise.resolve([...rows]),
      getManyAndCount: () => Promise.resolve([[...rows], rows.length] as const),
      update: () => ({
        set: () => ({
          where: () => ({
            andWhere: () => ({
              andWhere: () => ({
                execute: () => Promise.resolve({ affected: 1 }),
              }),
              execute: () => Promise.resolve({ affected: 1 }),
            }),
          }),
        }),
      }),
    }),
  };
}

describe('Bot reports HTTP API (/api/bot/v1)', () => {
  let app: INestApplication;
  let serviceToken = 'test-service-secret-0123456789';

  const reportsServiceMock = {
    getOrdersTodaySummary: jest.fn((date?: string) =>
      Promise.resolve({
        date: date ?? '2026-10-26',
        timezone: 'Asia/Tehran',
        totalOrders: 5,
        categories: {
          pending: 1,
          paid: 2,
          shipped: 1,
          delivered: 1,
          cancelled: 0,
          refundedOrCancelledAfterPayment: 0,
        },
      }),
    ),
    listOrders: jest.fn(() =>
      Promise.resolve({
        items: [
          {
            orderNumber: 'ORD-2026-01',
            status: 'paid',
            finalPrice: 1200000,
            currency: 'IRT',
            itemsCount: 1,
            createdAt: '2026-10-26T09:00:00.000Z',
            updatedAt: '2026-10-26T09:05:00.000Z',
          },
        ],
        pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
        timezone: 'Asia/Tehran',
      }),
    ),
    getOrderDetail: jest.fn(
      (
        orderNumber: string,
        opts: { canViewCustomer: boolean; includeCustomer: boolean },
      ) => {
        if (orderNumber === 'ORD-NOT-FOUND') return Promise.resolve(null);
        return Promise.resolve({
          orderNumber,
          status: 'paid',
          createdAt: '2026-10-26T09:00:00.000Z',
          updatedAt: '2026-10-26T09:05:00.000Z',
          itemsSubtotal: 1200000,
          discount: 0,
          shippingCost: 0,
          refundedAmount: 0,
          finalPrice: 1200000,
          total: 1200000,
          currency: 'IRT',
          items: [
            {
              productName: 'کیف نمونه',
              variant: 'مشکی / کوچک',
              sku: 'ZP-1',
              quantity: 1,
              unitPrice: 1200000,
              lineTotal: 1200000,
            },
          ],
          canViewCustomer: opts.canViewCustomer,
          customerAccessDenied: !opts.canViewCustomer,
          ...(opts.canViewCustomer && opts.includeCustomer
            ? {
                customer: {
                  fullName: 'کاربر تست بی‌نام',
                  phone: '09120000001',
                  province: 'تهران',
                  city: 'تهران',
                  address: 'نشانی آزمایشی',
                  postalCode: '1234567890',
                },
              }
            : {}),
        });
      },
    ),
    getSalesSummary: jest.fn(({ from, to }: { from: string; to: string }) =>
      Promise.resolve({
        from,
        to,
        timezone: 'Asia/Tehran',
        generatedAt: '2026-10-26T10:00:00.000Z',
        totalOrders: 3,
        paidOrders: 3,
        pendingOrders: 0,
        cancelledOrders: 0,
        refundedOrders: 0,
        grossSales: 3500000,
        discounts: 100000,
        refunds: 0,
        netSales: 3400000,
        shippingTotal: 100000,
        finalPaidTotal: 3500000,
        averageOrderValue: 1133333,
        currency: 'IRT',
        dailyBreakdown: [],
      }),
    ),
    exportSalesCsv: jest.fn(({ from, to }: { from: string; to: string }) =>
      Promise.resolve({
        filename: `zoppini-sales-${from}-${to}.csv`,
        totalRecords: 3,
        generatedAt: '2026-10-26T10:00:00.000Z',
        csvContent: '\uFEFFشماره سفارش,مبلغ\r\nORD-1,1000000\r\n',
      }),
    ),
    getCustomerSummary: jest.fn(() =>
      Promise.resolve({
        from: '2026-10-26',
        to: '2026-10-26',
        timezone: 'Asia/Tehran',
        generatedAt: '2026-10-26T10:00:00.000Z',
        newCustomers: 4,
        repeatCustomers: 2,
        activeBuyers: 5,
        firstTimeBuyers: 3,
      }),
    ),
    getInventorySummary: jest.fn(() =>
      Promise.resolve({
        unit: 'variant',
        canonicalStockField: 'variant.stock',
        threshold: 3,
        totalProducts: 10,
        totalVariants: 30,
        outOfStockVariants: 4,
        lowStockVariants: 6,
        inStockVariants: 20,
        sync: {
          status: 'ok',
          isStale: false,
          staleThresholdHours: 30,
          lastAttemptAt: '2026-10-26T08:00:00.000Z',
          lastSucceededAt: '2026-10-26T08:00:00.000Z',
          lastFailedAt: null,
          lastError: null,
          fallbackVariantUpdatedAt: '2026-10-26T08:00:00.000Z',
        },
      }),
    ),
    listInventory: jest.fn(() =>
      Promise.resolve({
        unit: 'variant',
        threshold: 3,
        items: [],
        pagination: { page: 1, limit: 15, total: 0, totalPages: 0 },
        sync: {
          status: 'ok',
          isStale: false,
          staleThresholdHours: 30,
          lastAttemptAt: '2026-10-26T08:00:00.000Z',
          lastSucceededAt: '2026-10-26T08:00:00.000Z',
          lastFailedAt: null,
          lastError: null,
          fallbackVariantUpdatedAt: '2026-10-26T08:00:00.000Z',
        },
      }),
    ),
    exportInventoryCsv: jest.fn(() =>
      Promise.resolve({
        filename: 'zoppini-inventory-all-2026-10-26.csv',
        totalRecords: 30,
        generatedAt: '2026-10-26T10:00:00.000Z',
        csvContent: '\uFEFFنام محصول,SKU,موجودی\r\nکیف نمونه,ZP-1,5\r\n',
      }),
    ),
    getSystemHealth: jest.fn(() =>
      Promise.resolve({
        ok: true,
        checkedAt: '2026-10-26T10:00:00.000Z',
        timezone: 'Asia/Tehran',
        database: 'up',
        sync: {
          status: 'ok',
          isStale: false,
          staleThresholdHours: 30,
          lastAttemptAt: '2026-10-26T08:00:00.000Z',
          lastSucceededAt: '2026-10-26T08:00:00.000Z',
          lastFailedAt: null,
          lastError: null,
          fallbackVariantUpdatedAt: '2026-10-26T08:00:00.000Z',
        },
        outbox: { pending: 0, leased: 0, failed: 0, deliveredLast24h: 5 },
      }),
    ),
  };

  function signedHeaders(
    method: string,
    pathWithQuery: string,
    actorId = '111',
    chatType = 'private',
    body?: unknown,
  ) {
    const timestamp = String(Date.now());
    const nonce = `nonce-${randomUUID()}`;
    const bodySha256 = computeBodySha256(
      body !== undefined && method !== 'GET' ? body : '',
    );
    const signingKey = deriveActorSigningKey(serviceToken);
    const sig = computeBotRequestSignature(signingKey, {
      timestamp,
      nonce,
      method,
      pathWithQuery,
      actorId,
      chatType,
      bodySha256,
    });
    return {
      Authorization: `Bearer ${serviceToken}`,
      [BOT_ACTOR_ID_HEADER]: actorId,
      [BOT_CHAT_TYPE_HEADER]: chatType,
      [BOT_TIMESTAMP_HEADER]: timestamp,
      [BOT_NONCE_HEADER]: nonce,
      [BOT_SIGNATURE_HEADER]: sig,
    };
  }

  beforeAll(async () => {
    const operatorStore = createMemoryEntityStore<BotOperator>([
      {
        id: 1,
        baleUserId: '111',
        role: 'owner' as any,
        isActive: true,
        receiveOrderAlerts: true,
        receiveInventoryAlerts: true,
        receiveHealthAlerts: true,
      } as BotOperator,
      {
        id: 2,
        baleUserId: '222',
        role: 'orders-read-only' as any,
        isActive: true,
        receiveOrderAlerts: false,
        receiveInventoryAlerts: false,
        receiveHealthAlerts: false,
      } as BotOperator,
      {
        id: 3,
        baleUserId: '333',
        role: 'reports-read-only' as any,
        isActive: true,
        receiveOrderAlerts: false,
        receiveInventoryAlerts: false,
        receiveHealthAlerts: false,
      } as BotOperator,
    ]);
    const settingStore = createMemoryEntityStore<BotSetting>();
    const outboxStore = createMemoryEntityStore<BotOutboxEvent>();
    const alertStateStore = createMemoryEntityStore<BotInventoryAlertState>();
    const variantStore = createMemoryEntityStore<Variant>();

    const moduleRef = await Test.createTestingModule({
      controllers: [BotReportsController],
      providers: [
        BotServiceKeyGuard,
        BotRoleGuard,
        BotAccessService,
        BotSettingsService,
        BotEventsService,
        { provide: BOT_REPORTS_READER, useValue: reportsServiceMock },
        { provide: getRepositoryToken(BotOperator), useValue: operatorStore },
        { provide: getRepositoryToken(BotSetting), useValue: settingStore },
        { provide: getRepositoryToken(BotOutboxEvent), useValue: outboxStore },
        {
          provide: getRepositoryToken(BotInventoryAlertState),
          useValue: alertStateStore,
        },
        { provide: getRepositoryToken(Variant), useValue: variantStore },
        {
          provide: DataSource,
          useValue: { query: jest.fn().mockResolvedValue([{ ok: 1 }]) },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'ZOPPINI_BOT_SERVICE_TOKEN') return serviceToken;
              if (key === 'ZOPPINI_BOT_OWNER_BALE_IDS') return '111';
              return '';
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    serviceToken = 'test-service-secret-0123456789';
    jest.clearAllMocks();
  });

  it('بدون توکن تنظیم‌شده روی سرور پاسخ 503 می‌دهد (fail-closed)', async () => {
    serviceToken = '';
    const path = '/api/bot/v1/reports/sales?from=2026-10-26&to=2026-10-26';
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer anything')
      .expect(503);
  });

  it('درخواست بدون هدر امضا یا با کاربر غیرمجاز را به ترتیب با 401 و 403 رد می‌کند', async () => {
    const path = '/api/bot/v1/reports/sales?from=2026-10-26&to=2026-10-26';

    // بدون امضا → 401
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${serviceToken}`)
      .expect(401);

    // امضای معتبر اما کاربر ناشناس (999) → 403
    await request(app.getHttpServer())
      .get(path)
      .set(signedHeaders('GET', path, '999'))
      .expect(403);
  });

  it('نقش orders-read-only به سفارش‌ها دسترسی دارد ولی از گزارش فروش و اطلاعات شخصی مشتری منع می‌شود', async () => {
    // ۱. خلاصه سفارش‌ها برای orders-read-only مجاز است (200)
    const ordSummaryPath = '/api/bot/v1/orders/summary?date=2026-10-26';
    const summaryRes = await request(app.getHttpServer())
      .get(ordSummaryPath)
      .set(signedHeaders('GET', ordSummaryPath, '222'))
      .expect(200);
    expect(summaryRes.body.totalOrders).toBe(5);

    // ۲. جزئیات سفارش بدون includeCustomer مجاز است ولی customerAccessDenied = true دارد و customer ندارد
    const ordDetailPath = '/api/bot/v1/orders/ORD-2026-01';
    const detailRes = await request(app.getHttpServer())
      .get(ordDetailPath)
      .set(signedHeaders('GET', ordDetailPath, '222'))
      .expect(200);
    expect(detailRes.body.customerAccessDenied).toBe(true);
    expect(detailRes.body.customer).toBeUndefined();

    // ۳. درخواست صریح includeCustomer=true توسط orders-read-only → 403
    const piiPath = '/api/bot/v1/orders/ORD-2026-01?includeCustomer=true';
    await request(app.getHttpServer())
      .get(piiPath)
      .set(signedHeaders('GET', piiPath, '222'))
      .expect(403);

    // ۴. درخواست گزارش فروش توسط orders-read-only → 403
    const salesPath = '/api/bot/v1/reports/sales?from=2026-10-26&to=2026-10-26';
    await request(app.getHttpServer())
      .get(salesPath)
      .set(signedHeaders('GET', salesPath, '222'))
      .expect(403);
  });

  it('مالک می‌تواند تنظیمات را پایدار تغییر دهد، اطلاعات مشتری را ببیند و فایل CSV را با هدر X-Total-Records دریافت کند', async () => {
    // تغییر آستانه کم‌موجودی توسط owner (111)
    const settingsPath = '/api/bot/v1/settings';
    const patchBody = { lowStockThreshold: 6, notifyOrderCreated: false };
    const patchRes = await request(app.getHttpServer())
      .patch(settingsPath)
      .set(signedHeaders('PATCH', settingsPath, '111', 'private', patchBody))
      .send(patchBody)
      .expect(200);
    expect(patchRes.body.lowStockThreshold).toBe(6);
    expect(patchRes.body.notifyOrderCreated).toBe(false);

    // خواندن مجدد تنظیمات → مقدار پایدار است
    const getSettingsRes = await request(app.getHttpServer())
      .get(settingsPath)
      .set(signedHeaders('GET', settingsPath, '111'))
      .expect(200);
    expect(getSettingsRes.body.lowStockThreshold).toBe(6);

    // دریافت خروجی CSV به صورت JSON و به صورت خام text/csv با هدر X-Total-Records
    const invExportPath = '/api/bot/v1/inventory/export?category=all';
    const jsonExport = await request(app.getHttpServer())
      .get(invExportPath)
      .set(signedHeaders('GET', invExportPath, '111'))
      .expect(200);
    expect(jsonExport.headers['x-total-records']).toBe('30');
    expect(jsonExport.body.totalRecords).toBe(30);

    const rawCsvExport = await request(app.getHttpServer())
      .get(invExportPath)
      .set({
        ...signedHeaders('GET', invExportPath, '111'),
        Accept: 'text/csv',
      })
      .expect(200);
    expect(rawCsvExport.headers['content-type']).toContain('text/csv');
    expect(rawCsvExport.text).toContain('کیف نمونه,ZP-1,5');
  });

  it('مسیرهای داخلی Lease و Ack صف Outbox فقط برای Actor سیستمی مجاز هستند و برای کاربر عادی 403 می‌دهند', async () => {
    const leasePath = '/api/bot/v1/events/lease';
    const leaseBody = { workerId: 'bot-worker-1', limit: 5 };

    // حتی مالک انسانی هم به صورت مستقیم مجاز به فراخوانی مسیر سیستمی lease نیست
    await request(app.getHttpServer())
      .post(leasePath)
      .set(signedHeaders('POST', leasePath, '111', 'private', leaseBody))
      .send(leaseBody)
      .expect(403);

    // Worker سیستمی با امضای معتبر مجاز است
    const sysRes = await request(app.getHttpServer())
      .post(leasePath)
      .set(signedHeaders('POST', leasePath, 'system', 'system', leaseBody))
      .send(leaseBody)
      .expect(200);
    expect(Array.isArray(sysRes.body.events)).toBe(true);
  });

  it('ورودی‌های بدشکل تاریخ، شماره سفارش و پارامترهای ناشناس با 400 رد می‌شوند', async () => {
    const badRange = '/api/bot/v1/reports/sales?from=2026-10-30&to=2026-10-01';
    await request(app.getHttpServer())
      .get(badRange)
      .set(signedHeaders('GET', badRange, '111'))
      .expect(400);

    const unknownQuery = '/api/bot/v1/inventory?category=low&extraInjected=1';
    await request(app.getHttpServer())
      .get(unknownQuery)
      .set(signedHeaders('GET', unknownQuery, '111'))
      .expect(400);
  });
});
