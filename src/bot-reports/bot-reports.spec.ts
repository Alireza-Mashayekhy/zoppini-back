import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { OrderStatus } from '../order/entities/order.entity';
import { BOT_ACCESS_METADATA_KEY } from './bot-access.decorator';
import { BotAccessService } from './bot-access.service';
import {
  BOT_ACTOR_ID_HEADER,
  BOT_CHAT_TYPE_HEADER,
  BOT_NONCE_HEADER,
  BOT_SIGNATURE_HEADER,
  BOT_TIMESTAMP_HEADER,
  canonicalJson,
  computeBodySha256,
  computeBotRequestSignature,
  deriveActorSigningKey,
} from './bot-auth.util';
import { buildUtf8Csv } from './bot-csv.util';
import { BotEventsService } from './bot-events.service';
import { BotReportsService } from './bot-reports.service';
import { BotRoleGuard } from './bot-role.guard';
import { BotServiceKeyGuard } from './bot-service-key.guard';
import { BotSettingsService } from './bot-settings.service';
import { BotInventoryAlertState } from './entities/bot-inventory-alert-state.entity';
import { BotOperator } from './entities/bot-operator.entity';
import {
  BotEventType,
  BotOutboxEvent,
} from './entities/bot-outbox-event.entity';
import { BotSetting } from './entities/bot-setting.entity';

function createInMemoryRepo<T extends { id?: number | string }>(
  seed: T[] = [],
) {
  const rows: T[] = [...seed];
  let seq = 1;

  const matchesWhere = (
    row: Record<string, any>,
    where: Record<string, any>,
  ): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && '_type' in v) {
        if (v._type === 'in') return (v._value as any[]).includes(row[k]);
        if (v._type === 'lessThan') return row[k] < v._value;
      }
      return row[k] === v;
    });

  return {
    rows,
    create: jest.fn((partial: Partial<T>) => ({ ...partial }) as T),
    save: jest.fn((entity: T) => {
      if (!entity.id) {
        entity.id = seq++;
      }
      const idx = rows.findIndex(r => r.id === entity.id);
      if (idx >= 0) {
        rows[idx] = { ...rows[idx], ...entity };
        return Promise.resolve(rows[idx]);
      }
      rows.push(entity);
      return Promise.resolve(entity);
    }),
    findOne: jest.fn(({ where }: { where: Record<string, any> }) => {
      return Promise.resolve(
        rows.find(r => matchesWhere(r as Record<string, any>, where)) ?? null,
      );
    }),
    find: jest.fn((opts?: { where?: Record<string, any> }) => {
      if (!opts?.where) return Promise.resolve([...rows]);
      return Promise.resolve(
        rows.filter(r => matchesWhere(r as Record<string, any>, opts.where!)),
      );
    }),
    count: jest.fn((opts?: { where?: Record<string, any> }) => {
      if (!opts?.where) return Promise.resolve(rows.length);
      return Promise.resolve(
        rows.filter(r => matchesWhere(r as Record<string, any>, opts.where!))
          .length,
      );
    }),
    createQueryBuilder: jest.fn(),
  };
}

function makeSignedExecutionContext(opts: {
  token: string;
  signingSecret?: string;
  method?: string;
  originalUrl?: string;
  actorId?: string;
  chatType?: string;
  body?: unknown;
  timestampOffsetMs?: number;
  nonce?: string;
}) {
  const method = opts.method ?? 'GET';
  const originalUrl =
    opts.originalUrl ??
    '/api/bot/v1/reports/sales?from=2026-10-26&to=2026-10-26';
  const actorId = opts.actorId ?? '111222';
  const chatType = opts.chatType ?? 'private';
  const timestamp = String(Date.now() + (opts.timestampOffsetMs ?? 0));
  const nonce =
    opts.nonce ?? `nonce-${Math.random().toString(36).slice(2, 12)}`;
  const bodyForSign =
    opts.body !== undefined && method !== 'GET' ? opts.body : '';
  const bodySha256 = computeBodySha256(bodyForSign);
  const signingKey = deriveActorSigningKey(opts.token, opts.signingSecret);

  const sig = computeBotRequestSignature(signingKey, {
    timestamp,
    nonce,
    method,
    pathWithQuery: originalUrl,
    actorId,
    chatType,
    bodySha256,
  });

  const request: Record<string, any> = {
    method,
    originalUrl,
    body: opts.body ?? {},
    headers: {
      authorization: `Bearer ${opts.token}`,
      [BOT_ACTOR_ID_HEADER]: actorId,
      [BOT_CHAT_TYPE_HEADER]: chatType,
      [BOT_TIMESTAMP_HEADER]: timestamp,
      [BOT_NONCE_HEADER]: nonce,
      [BOT_SIGNATURE_HEADER]: sig,
    },
  };

  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class DummyController {},
  } as any;

  return { context, request };
}

describe('BotServiceKeyGuard & HMAC Actor Signing', () => {
  it('امضای معتبر، چرخش کلید بدون قطعی (previous token) و رد حملات Replay/Group/Expired/Forged را اعمال می‌کند', () => {
    const configMap: Record<string, string> = {
      ZOPPINI_BOT_SERVICE_TOKEN: 'current-secret-token-123456',
      ZOPPINI_BOT_SERVICE_TOKEN_PREVIOUS: 'previous-secret-token-654321',
    };
    const guard = new BotServiceKeyGuard({
      get: (key: string) => configMap[key],
    } as unknown as ConfigService);

    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');

    // ۱. درخواست معتبر با کلید فعلی
    const valid = makeSignedExecutionContext({
      token: 'current-secret-token-123456',
      nonce: 'unique-nonce-0001',
    });
    expect(guard.canActivate(valid.context)).toBe(true);
    expect(valid.request.botAuth).toEqual({
      actorType: 'user',
      baleUserId: '111222',
      chatType: 'private',
    });

    // ۲. حملهٔ Replay با همان Nonce → رد می‌شود
    expect(() => guard.canActivate(valid.context)).toThrow(
      UnauthorizedException,
    );

    // ۳. درخواست معتبر با کلید قبلی حین چرخش کلید → پذیرفته می‌شود
    const rotated = makeSignedExecutionContext({
      token: 'previous-secret-token-654321',
      nonce: 'unique-nonce-0002',
    });
    expect(guard.canActivate(rotated.context)).toBe(true);

    // ۴. درخواست از چت گروهی (chatType = group) → رد می‌شود
    const groupCtx = makeSignedExecutionContext({
      token: 'current-secret-token-123456',
      chatType: 'group',
      nonce: 'unique-nonce-0003',
    });
    expect(() => guard.canActivate(groupCtx.context)).toThrow(
      UnauthorizedException,
    );

    // ۵. درخواست منقضی‌شده (۱۰ دقیقه اختلاف زمان) → رد می‌شود
    const expiredCtx = makeSignedExecutionContext({
      token: 'current-secret-token-123456',
      timestampOffsetMs: -10 * 60 * 1000,
      nonce: 'unique-nonce-0004',
    });
    expect(() => guard.canActivate(expiredCtx.context)).toThrow(
      UnauthorizedException,
    );

    // ۶. دستکاری شناسهٔ کاربر بله پس از امضا (تلاش برای جعل هویت مالک) → رد می‌شود
    const forgedCtx = makeSignedExecutionContext({
      token: 'current-secret-token-123456',
      actorId: '999999',
      nonce: 'unique-nonce-0005',
    });
    forgedCtx.request.headers[BOT_ACTOR_ID_HEADER] = '111222';
    expect(() => guard.canActivate(forgedCtx.context)).toThrow(
      UnauthorizedException,
    );
  });

  it('در صورت تنظیم‌نبودن ZOPPINI_BOT_SERVICE_TOKEN با 503 بسته می‌ماند (fail-closed)', () => {
    const guard = new BotServiceKeyGuard({
      get: () => '',
    } as unknown as ConfigService);
    const { context } = makeSignedExecutionContext({ token: 'any' });
    expect(() => guard.canActivate(context)).toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('BotAccessService & RBAC Roles', () => {
  it('نقش‌های چهارگانه، محافظت از مالک env و مجوزهای اطلاعات مشتری را دقیق اعمال می‌کند', async () => {
    const operatorRepo = createInMemoryRepo<BotOperator>();
    const accessService = new BotAccessService(
      operatorRepo as any,
      {
        get: (key: string) =>
          key === 'ZOPPINI_BOT_OWNER_BALE_IDS' ? '100' : '',
      } as unknown as ConfigService,
    );

    // مالک اولیه از env خوانده شده و قابل حذف نیست
    const ownerProfile = await accessService.getCallerProfile('100');
    expect(ownerProfile.authorized).toBe(true);
    expect(ownerProfile.role).toBe('owner');
    expect(ownerProfile.permissions).toContain('orders:customer_pii');
    expect(ownerProfile.permissions).toContain('settings:write');

    await expect(
      accessService.deactivateOperator('100', '100'),
    ).rejects.toThrow(ForbiddenException);

    // افزودن نقش orders-read-only توسط مالک
    await accessService.upsertOperator({
      actorBaleId: '100',
      targetBaleUserId: '200',
      role: 'orders-read-only',
    });

    const ordersRoProfile = await accessService.getCallerProfile('200');
    expect(ordersRoProfile.authorized).toBe(true);
    expect(ordersRoProfile.role).toBe('orders-read-only');
    expect(ordersRoProfile.permissions).toContain('orders:read');
    expect(ordersRoProfile.permissions).not.toContain('orders:customer_pii');
    expect(ordersRoProfile.permissions).not.toContain('sales:read');

    // بررسی گارد نقش برای مجوز settings:write روی کاربر orders-read-only
    const reflector = {
      getAllAndOverride: jest.fn((metaKey: string) => {
        if (metaKey === BOT_ACCESS_METADATA_KEY) {
          return { mode: 'permissions', permissions: ['settings:write'] };
        }
        return undefined;
      }),
    } as unknown as Reflector;

    const roleGuard = new BotRoleGuard(reflector, accessService);
    await expect(
      roleGuard.canActivate({
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            botAuth: {
              actorType: 'user',
              baleUserId: '200',
              chatType: 'private',
            },
          }),
        }),
      } as any),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('BotEventsService: Outbox Idempotency, Stock State Machine & Sync Health', () => {
  function setupEventsFixture() {
    const settingRepo = createInMemoryRepo<BotSetting>();
    const variantMockRepo = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        getRawOne: jest
          .fn()
          .mockResolvedValue({ lastSyncedAt: '2026-10-26T07:00:00.000Z' }),
      })),
    };
    const settingsService = new BotSettingsService(
      settingRepo as any,
      variantMockRepo as any,
    );

    const operatorRepo = createInMemoryRepo<BotOperator>([
      {
        id: 1,
        baleUserId: '100',
        role: 'owner' as any,
        isActive: true,
        receiveOrderAlerts: true,
        receiveInventoryAlerts: true,
        receiveHealthAlerts: true,
      } as BotOperator,
    ]);
    const accessService = new BotAccessService(
      operatorRepo as any,
      { get: () => '100' } as unknown as ConfigService,
    );

    const outboxRepo = createInMemoryRepo<BotOutboxEvent>();
    const alertStateRepo = createInMemoryRepo<BotInventoryAlertState>();

    const managerMock = {
      getRepository: (entity: unknown) => {
        if (entity === BotOutboxEvent) return outboxRepo;
        if (entity === BotInventoryAlertState) return alertStateRepo;
        return settingRepo;
      },
    } as any;

    const eventsService = new BotEventsService(
      outboxRepo as any,
      alertStateRepo as any,
      settingRepo as any,
      settingsService,
      accessService,
      { query: jest.fn().mockResolvedValue([{ ok: 1 }]) } as any,
    );

    return {
      eventsService,
      settingsService,
      outboxRepo,
      alertStateRepo,
      managerMock,
    };
  }

  it('ثبت رویداد سفارش با کلید Idempotency تکراری نمی‌شود و داده‌های حساس را حذف می‌کند', async () => {
    const { eventsService, outboxRepo, managerMock } = setupEventsFixture();

    await eventsService.recordOrderCreatedInTransaction(managerMock, {
      id: 101,
      orderNumber: 'ORD-5001',
      status: OrderStatus.PENDING,
      finalPrice: 1200000,
      items: [{ quantity: 2 }] as any,
      createdAt: new Date('2026-10-26T08:00:00.000Z'),
    });
    // فراخوانی تکراری با همان سفارش → نباید رکورد دوم بسازد
    await eventsService.recordOrderCreatedInTransaction(managerMock, {
      id: 101,
      orderNumber: 'ORD-5001',
      status: OrderStatus.PENDING,
      finalPrice: 1200000,
      items: [{ quantity: 2 }] as any,
      createdAt: new Date('2026-10-26T08:00:00.000Z'),
    });

    expect(outboxRepo.rows).toHaveLength(1);
    expect(outboxRepo.rows[0].eventType).toBe('order.created');
    expect(outboxRepo.rows[0].payload).not.toHaveProperty('nationalCode');
    expect(outboxRepo.rows[0].payload).not.toHaveProperty('phone');

    // تست صریح حذف کلیدهای حساس حتی اگر به enqueue داده شوند
    await eventsService.enqueue({
      idempotencyKey: 'test-sanitize-1',
      eventType: 'order.paid' as any,
      category: 'order_paid' as any,
      payload: {
        orderNumber: 'ORD-5002',
        nationalCode: '0011223344',
        phone: '09120000000',
        password: 'hash',
        gatewayResponse: { raw: 'card-pan' },
        ip: '1.2.3.4',
      },
    });
    const sanitized = outboxRepo.rows[1].payload;
    expect(sanitized.orderNumber).toBe('ORD-5002');
    expect(sanitized.nationalCode).toBeUndefined();
    expect(sanitized.phone).toBeUndefined();
    expect(sanitized.password).toBeUndefined();
    expect(sanitized.gatewayResponse).toBeUndefined();
    expect(sanitized.ip).toBeUndefined();
  });

  it('ماشین وضعیت موجودی فقط در گذار واقعی هشدار می‌دهد و پس از شارژ مجدد مسلح می‌شود', async () => {
    const { eventsService, outboxRepo } = setupEventsFixture();

    const baseCtx = {
      variantId: 55,
      productTitle: 'کیف دوشی نمونه',
      variantLabel: 'عسلی / متوسط',
      sku: 'ZP-101',
      syncedAt: new Date('2026-10-26T08:00:00.000Z'),
    };

    // ۱. افت از ۱۰ به ۳ (ورود به کم‌موجودی با آستانه پیش‌فرض ۳) → ۱ هشدار low_stock
    await eventsService.evaluateVariantStockTransitions([
      { ...baseCtx, oldStock: 10, newStock: 3 },
    ]);
    expect(outboxRepo.rows).toHaveLength(1);
    expect(outboxRepo.rows[0].eventType).toBe('inventory.low_stock');

    // ۲. تغییر از ۳ به ۲ (همچنان در بازهٔ کم‌موجود) → بدون هشدار تکراری
    await eventsService.evaluateVariantStockTransitions([
      { ...baseCtx, oldStock: 3, newStock: 2 },
    ]);
    expect(outboxRepo.rows).toHaveLength(1);

    // ۳. افت از ۲ به ۰ (ورود به ناموجودی) → ۱ هشدار out_of_stock
    await eventsService.evaluateVariantStockTransitions([
      { ...baseCtx, oldStock: 2, newStock: 0 },
    ]);
    expect(outboxRepo.rows).toHaveLength(2);
    expect(outboxRepo.rows[1].eventType).toBe('inventory.out_of_stock');

    // ۴. ماندن روی ۰ در sync بعدی → بدون هشدار تکراری
    await eventsService.evaluateVariantStockTransitions([
      { ...baseCtx, oldStock: 0, newStock: 0 },
    ]);
    expect(outboxRepo.rows).toHaveLength(2);

    // ۵. شارژ مجدد بالای آستانه (۰ به ۸) → مسلح‌شدن مجدد بدون هشدار خطا
    await eventsService.evaluateVariantStockTransitions([
      { ...baseCtx, oldStock: 0, newStock: 8 },
    ]);
    expect(outboxRepo.rows).toHaveLength(2);

    // ۶. افت مجدد از ۸ به ۱ در اپیزود جدید → هشدار جدید صادر می‌شود
    await eventsService.evaluateVariantStockTransitions([
      { ...baseCtx, oldStock: 8, newStock: 1 },
    ]);
    expect(outboxRepo.rows).toHaveLength(3);
    expect(outboxRepo.rows[2].eventType).toBe('inventory.low_stock');
  });

  it('خطای همگام‌سازی راهکاران بدون اسپم ثبت می‌شود و پس از رفع، اعلان بازیابی می‌دهد', async () => {
    const { eventsService, outboxRepo } = setupEventsFixture();

    await eventsService.recordSyncFailed(new Error('ECONNREFUSED Rahkaran'));
    await eventsService.recordSyncFailed(
      new Error('ECONNREFUSED Rahkaran again'),
    );

    // فقط ۱ رویداد sync.failed برای یک حادثهٔ باز ثبت می‌شود
    expect(
      outboxRepo.rows.filter(r => r.eventType === BotEventType.SYNC_FAILED),
    ).toHaveLength(1);

    // پس از موفقیت sync → دقیقاً ۱ رویداد sync.recovered ثبت می‌شود
    await eventsService.recordSyncSucceeded({
      received: 120,
      matched: 120,
      updated: 14,
      unchanged: 106,
      skipped: 0,
      failed: 0,
      durationSeconds: 4,
    });
    expect(
      outboxRepo.rows.filter(r => r.eventType === BotEventType.SYNC_RECOVERED),
    ).toHaveLength(1);
  });
});

describe('BotReportsService & CSV Safety', () => {
  it('فروش ناخالص، تخفیف، بازپرداخت واقعی (بدون سفارش‌های لغوشدهٔ پرداخت‌نشده) و فروش خالص را دقیق محاسبه می‌کند', async () => {
    const statusCountsQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { status: OrderStatus.PAID, count: '2' },
        { status: OrderStatus.PENDING, count: '1' },
        { status: OrderStatus.CANCELLED, count: '2' }, // یکی پرداخت‌نشده، یکی پرداخت‌شده و عودتی
      ]),
    };

    const paidSumsQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({
        paidOrders: '2',
        grossItems: '2000000',
        discounts: '200000',
        shippingTotal: '100000',
        finalPaidTotal: '1900000',
      }),
    };

    const cancelledOrdersQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        // سفارش لغوشدهٔ ۱: قبلاً در درگاه پرداخت شده بود (باید در ناخالص و بازپرداخت لحاظ شود)
        {
          id: 901,
          totalPrice: 800000,
          discount: 50000,
          shippingCost: 50000,
          finalPrice: 800000,
          createdAt: new Date('2026-10-26T09:00:00.000Z'),
        },
        // سفارش لغوشدهٔ ۲: هرگز پرداخت نشده بود (نباید بازپرداخت شمرده شود!)
        {
          id: 902,
          totalPrice: 5000000,
          discount: 0,
          shippingCost: 0,
          finalPrice: 5000000,
          createdAt: new Date('2026-10-26T10:00:00.000Z'),
        },
      ]),
    };

    const dailyQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        {
          day: '2026-10-26',
          paidOrders: '2',
          netSales: '1800000',
        },
      ]),
    };

    let orderQbCall = 0;
    const orderRepo = {
      createQueryBuilder: jest.fn(() => {
        orderQbCall += 1;
        if (orderQbCall === 1) return statusCountsQb;
        if (orderQbCall === 2) return paidSumsQb;
        if (orderQbCall === 3) return cancelledOrdersQb;
        return dailyQb;
      }),
    };

    const paymentRepo = {
      find: jest
        .fn()
        // سفارش 901 مبلغ 8,000,000 ریال (= 800,000 تومان) پرداخت تاییدشده دارد
        .mockResolvedValue([{ id: 1, orderId: 901, amount: 8000000 }]),
    };

    const walletTxRepo = {
      find: jest.fn().mockResolvedValue([]),
    };

    const service = new BotReportsService(
      orderRepo as any,
      {} as any,
      {} as any,
      {} as any,
      paymentRepo as any,
      walletTxRepo as any,
      {} as any,
    );

    const report = await service.getSalesSummary({
      from: '2026-10-26',
      to: '2026-10-26',
    });

    // ناخالص = 2,000,000 + 800,000 = 2,800,000
    // تخفیف = 200,000 + 50,000 = 250,000
    // بازپرداخت واقعی (بدون هزینه ارسال و بدون سبد پرداخت‌نشده) = 800,000 - 50,000 = 750,000
    // خالص = 2,800,000 - 250,000 - 750,000 = 1,800,000
    expect(report.grossSales).toBe(2_800_000);
    expect(report.discounts).toBe(250_000);
    expect(report.refunds).toBe(750_000);
    expect(report.refundedOrders).toBe(1);
    expect(report.netSales).toBe(1_800_000);
    expect(report.shippingTotal).toBe(100_000);
    expect(report.averageOrderValue).toBe(900_000);
    expect(report.currency).toBe('IRT');
    expect(report.timezone).toBe('Asia/Tehran');
  });

  it('خروجی CSV شامل UTF-8 BOM است و فرمول‌های خطرناک اکسل را خنثی می‌کند', () => {
    const csv = buildUtf8Csv({
      metadataCells: ['نام فایل: test.csv'],
      headers: ['نام محصول', 'SKU', 'موجودی'],
      rows: [['=HYPERLINK("http://evil")', 'ZP-01,A', 0]],
    });

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain('"ZP-01,A",0');
  });
});
