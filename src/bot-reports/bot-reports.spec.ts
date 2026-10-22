import {
  BadRequestException,
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OrderStatus } from 'src/order/entities/order.entity';

import { BotReportsReader } from './bot-reports.contract';
import { BotReportsController } from './bot-reports.controller';
import { BotReportsService } from './bot-reports.service';
import { BotServiceKeyGuard } from './bot-service-key.guard';

/**
 * تست‌های واحد API گزارش‌های ربات بله.
 *
 * دیتابیس واقعی در دسترس نیست؛ ریپازیتوری‌ها با QueryBuilder زنجیره‌ای ماک
 * شده‌اند و شکل خروجی قرارداد، تعریف‌های مالی (وضعیت‌های پرداخت‌شده، واحد
 * تومان، refunds=0) و حذف دادهٔ شخصی از خروجی سفارش سنجیده می‌شود.
 */

const RANGE = {
  from: '2026-10-21',
  to: '2026-10-21',
  timezone: 'Asia/Tehran' as const,
};

/** ساخت QueryBuilder ماک که فراخوانی‌ها را برای assert نگه می‌دارد */
function createQueryBuilderMock(terminal: Record<string, unknown>) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const qb: Record<string, unknown> = { calls };

  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'take',
    'leftJoinAndSelect',
    'innerJoin',
    'setParameters',
  ]) {
    qb[method] = jest.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return qb;
    });
  }

  for (const [method, value] of Object.entries(terminal)) {
    qb[method] = jest.fn(() => Promise.resolve(value));
  }

  return qb;
}

function createService(repos: {
  orderRepo?: unknown;
  variantRepo?: unknown;
  userRepo?: unknown;
}) {
  return new BotReportsService(
    (repos.orderRepo ?? {}) as never,
    (repos.variantRepo ?? {}) as never,
    (repos.userRepo ?? {}) as never,
  );
}

describe('BotReportsService', () => {
  it('فروش را فقط از سفارش‌های پرداخت‌شده و به تومان خلاصه می‌کند', async () => {
    const qb = createQueryBuilderMock({
      getRawOne: { paidOrders: '3', grossSales: '1500000.00' },
    });
    const service = createService({
      orderRepo: { createQueryBuilder: jest.fn(() => qb) },
    });

    const summary = await service.getSalesSummary(RANGE);

    expect(summary).toMatchObject({
      from: '2026-10-21',
      to: '2026-10-21',
      timezone: 'Asia/Tehran',
      currency: 'IRT',
      paidOrders: 3,
      grossSales: 1500000,
      refunds: 0,
      netSales: 1500000,
      averageOrderValue: 500000,
    });
    expect(typeof summary.generatedAt).toBe('string');

    const statusFilter = (
      qb.calls as Array<{ method: string; args: unknown[] }>
    ).find(call => String(call.args[0]).includes('order.status IN'));
    expect(statusFilter?.args[1]).toEqual({
      statuses: [OrderStatus.PAID, OrderStatus.SHIPPED, OrderStatus.DELIVERED],
    });

    const bounds = (qb.calls as Array<{ method: string; args: unknown[] }>)
      .filter(call => call.method === 'where' || call.method === 'andWhere')
      .map(call => call.args[1]);
    expect(bounds).toContainEqual({ start: '2026-10-21 00:00:00' });
    expect(bounds).toContainEqual({ endExclusive: '2026-10-22 00:00:00' });
  });

  it('برای روز بدون فروش میانگین سفارش صفر برمی‌گرداند', async () => {
    const qb = createQueryBuilderMock({
      getRawOne: { paidOrders: '0', grossSales: '0' },
    });
    const service = createService({
      orderRepo: { createQueryBuilder: jest.fn(() => qb) },
    });

    const summary = await service.getSalesSummary(RANGE);

    expect(summary.paidOrders).toBe(0);
    expect(summary.averageOrderValue).toBe(0);
  });

  it('موجودی کم را با برچسب رنگ/سایز و زمان همگام‌سازی تهران می‌سازد', async () => {
    const itemsQb = createQueryBuilderMock({
      getMany: [
        {
          productId: 11,
          stock: 2,
          sku: 'ZP-11-BLK-L',
          product: { title: 'کت تک' },
          color: { name: 'مشکی' },
          size: { name: 'L' },
        },
        {
          productId: 7,
          stock: 0,
          sku: null,
          product: undefined,
          color: undefined,
          size: undefined,
        },
      ],
    });
    const syncQb = createQueryBuilderMock({
      getRawOne: { inventorySyncedAt: '2026-10-21 08:30:00' },
    });
    const service = createService({
      variantRepo: {
        createQueryBuilder: jest
          .fn()
          .mockReturnValueOnce(itemsQb)
          .mockReturnValueOnce(syncQb),
      },
    });

    const report = await service.getLowStock({ threshold: 3 });

    expect(report.threshold).toBe(3);
    expect(report.inventorySyncedAt).toBe('2026-10-21T08:30:00+03:30');
    expect(report.items).toEqual([
      {
        productName: 'کت تک',
        variant: 'مشکی / L',
        sku: 'ZP-11-BLK-L',
        stock: 2,
      },
      { productName: 'محصول 7', variant: null, sku: null, stock: 0 },
    ]);
  });

  it('سفارش را بدون هیچ دادهٔ شخصی مشتری برمی‌گرداند', async () => {
    const order = {
      orderNumber: 'ORD-12345678-0042',
      status: OrderStatus.PAID,
      // Date محلی: اجزای آن همان ساعت دیواری دیتابیس فرض می‌شوند
      createdAt: new Date(2026, 9, 21, 10, 5, 3),
      finalPrice: '250000.50',
      user: { fullName: 'مشتری تست', phone: '09120000000' },
      address: { id: 1 },
      note: 'یادداشت خصوصی',
      items: [
        {
          quantity: 2,
          price: '100000.00',
          variant: {
            product: { title: 'شلوار پارچه‌ای' },
            color: { name: 'سرمه‌ای' },
            size: { name: '48' },
          },
        },
        { quantity: 1, price: '50000.50', variant: null },
      ],
    };
    const service = createService({
      orderRepo: { findOne: jest.fn(() => Promise.resolve(order)) },
    });

    const result = await service.getOrder('ORD-12345678-0042');

    expect(result).toEqual({
      orderNumber: 'ORD-12345678-0042',
      status: 'paid',
      createdAt: '2026-10-21T10:05:03+03:30',
      currency: 'IRT',
      total: 250000.5,
      items: [
        {
          productName: 'شلوار پارچه‌ای',
          variant: 'سرمه‌ای / 48',
          quantity: 2,
          unitPrice: 100000,
        },
        {
          productName: 'کالای حذف‌شده',
          variant: null,
          quantity: 1,
          unitPrice: 50000.5,
        },
      ],
    });
  });

  it('برای سفارش ناموجود null برمی‌گرداند', async () => {
    const service = createService({
      orderRepo: { findOne: jest.fn(() => Promise.resolve(null)) },
    });

    await expect(service.getOrder('ORD-0')).resolves.toBeNull();
  });

  it('مشتری جدید و تکراری را از دو کوئری جدا می‌سازد', async () => {
    const usersQb = createQueryBuilderMock({ getCount: 5 });
    const repeatQb = createQueryBuilderMock({
      getRawOne: { repeatCustomers: '2' },
    });
    const service = createService({
      userRepo: { createQueryBuilder: jest.fn(() => usersQb) },
      orderRepo: { createQueryBuilder: jest.fn(() => repeatQb) },
    });

    await expect(service.getCustomerSummary(RANGE)).resolves.toEqual({
      newCustomers: 5,
      repeatCustomers: 2,
    });

    const adminFilter = (
      usersQb.calls as Array<{ method: string; args: unknown[] }>
    ).some(call => String(call.args[0]).includes("FIND_IN_SET('admin'"));
    expect(adminFilter).toBe(true);
  });
});

describe('BotReportsController', () => {
  const reader: BotReportsReader = {
    getSalesSummary: jest.fn(range => Promise.resolve({ range }) as never),
    getCustomerSummary: jest.fn(() =>
      Promise.resolve({ newCustomers: 0, repeatCustomers: 0 }),
    ),
    getLowStock: jest.fn(input => Promise.resolve(input) as never),
    getOrder: jest.fn(() => Promise.resolve(null)),
  };
  const controller = new BotReportsController(reader);

  beforeEach(() => jest.clearAllMocks());

  it('بازهٔ معتبر را با منطقهٔ زمانی تهران به سرویس می‌دهد', async () => {
    await controller.sales('2026-10-01', '2026-10-21');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(reader.getSalesSummary).toHaveBeenCalledWith({
      from: '2026-10-01',
      to: '2026-10-21',
      timezone: 'Asia/Tehran',
    });
  });

  it.each([
    [undefined, '2026-10-21'],
    ['2026-10-21', undefined],
    ['21-10-2026', '2026-10-21'],
    ['2026-02-30', '2026-03-01'],
    ['2026-10-22', '2026-10-21'],
    ['2025-01-01', '2026-10-21'],
  ])('بازهٔ نامعتبر %s تا %s را رد می‌کند', (from, to) => {
    expect(() => controller.sales(from, to)).toThrow(BadRequestException);
  });

  it('threshold پیش‌فرض و نامعتبر موجودی را مدیریت می‌کند', async () => {
    await controller.lowStock();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(reader.getLowStock).toHaveBeenCalledWith({ threshold: 3 });

    expect(() => controller.lowStock('abc')).toThrow(BadRequestException);
    expect(() => controller.lowStock('-1')).toThrow(BadRequestException);
    expect(() => controller.lowStock('2.5')).toThrow(BadRequestException);
  });

  it('سفارش پیدا‌نشده را با notFound برمی‌گرداند و شمارهٔ بدشکل را رد می‌کند', async () => {
    await expect(controller.order('ORD-999')).resolves.toEqual({
      orderNumber: 'ORD-999',
      notFound: true,
    });

    await expect(controller.order('bad number!')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('BotServiceKeyGuard', () => {
  function createGuard(expectedToken?: string) {
    return new BotServiceKeyGuard({
      get: jest.fn(() => expectedToken),
    } as never);
  }

  function createContext(authorization?: string) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: authorization ? { authorization } : {},
        }),
      }),
    } as ExecutionContext;
  }

  it('بدون تنظیم توکن روی سرور، سرویس را غیرفعال اعلام می‌کند', () => {
    const guard = createGuard(undefined);

    expect(() => guard.canActivate(createContext('Bearer x'))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('توکن درست را قبول و بقیه را رد می‌کند', () => {
    const guard = createGuard('test-service-token');

    expect(guard.canActivate(createContext('Bearer test-service-token'))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(createContext('Bearer wrong-service-token')),
    ).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(createContext('Bearer short'))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(createContext())).toThrow(
      UnauthorizedException,
    );
    expect(() =>
      guard.canActivate(createContext('test-service-token')),
    ).toThrow(UnauthorizedException);
  });
});
