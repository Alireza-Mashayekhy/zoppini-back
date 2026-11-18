import { BadRequestException } from '@nestjs/common';

import { DiscountService } from './discounts.service';
import { CreateDiscountDto } from './dto/create-discount.dto';
import {
  Discount,
  DiscountKind,
  DiscountType,
} from './entities/discount.entity';

/**
 * تست‌های سطح سرویس برای «تخفیف متوالی».
 *
 * هدف: تضمین این‌که مسیر واقعیِ API (create/update/priceCartLines) هم
 * همان منطق موتور خالص را به‌کار می‌برد و رفتار تخفیف‌های قبلی تغییر نمی‌کند.
 */

const START = new Date('2024-01-01T00:00:00.000Z');
const END = new Date('2099-01-01T00:00:00.000Z');

function createService(overrides: Record<string, unknown> = {}) {
  const discountRepo = {
    create: jest.fn((value: Partial<Discount>) => ({ ...value })),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
    findOne: jest.fn().mockResolvedValue(null),
  };

  const service = Object.create(DiscountService.prototype) as DiscountService;

  Object.assign(service, {
    discountRepo,
    usageRepo: { count: jest.fn().mockResolvedValue(0) },
    redemptionRepo: { count: jest.fn().mockResolvedValue(0) },
    userRepo: { find: jest.fn().mockResolvedValue([]) },
    categoryRepo: { find: jest.fn().mockResolvedValue([]) },
    productRepo: { find: jest.fn().mockResolvedValue([]) },
    cartRepo: { findOne: jest.fn().mockResolvedValue(null) },
    ...overrides,
  });

  return { service, discountRepo };
}

function dto(overrides: Partial<CreateDiscountDto> = {}): CreateDiscountDto {
  return {
    kind: DiscountKind.SALE,
    title: 'مرحلهٔ تخفیف',
    type: DiscountType.PERCENTAGE,
    value: 20,
    startsAt: START.toISOString(),
    expiresAt: END.toISOString(),
    ...overrides,
  };
}

function activeSale(overrides: Partial<Discount> = {}) {
  return {
    id: 1,
    kind: DiscountKind.SALE,
    title: 'تخفیف',
    code: null,
    type: DiscountType.PERCENTAGE,
    value: 50,
    maxDiscountAmount: null,
    isActive: true,
    startsAt: START,
    expiresAt: END,
    stackable: false,
    stackPriority: 0,
    appliesToAllProducts: false,
    products: [],
    categories: [],
    scopeCategoryIds: new Set<number>(),
    ...overrides,
  };
}

describe('DiscountService – sequential discounts', () => {
  // ============================================================
  // ایجاد مرحلهٔ جدید
  // ============================================================

  it('مرحلهٔ دوم را با اولویت و دامنهٔ «همهٔ محصولات» می‌سازد', async () => {
    const { service, discountRepo } = createService();

    await service.create(
      dto({
        stackable: true,
        stackPriority: 1,
        appliesToAllProducts: true,
      }),
    );

    const saved = await discountRepo.save.mock.results[0].value;

    expect(saved).toEqual(
      expect.objectContaining({
        kind: DiscountKind.SALE,
        stackable: true,
        stackPriority: 1,
        appliesToAllProducts: true,
      }),
    );

    expect(saved.products).toEqual([]);
    expect(saved.categories).toEqual([]);
  });

  it('بدون «همهٔ محصولات» و بدون انتخاب محصول/دسته، خطای ۴۰۰ می‌دهد', async () => {
    const { service } = createService();

    await expect(service.create(dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('فروش ویژهٔ قدیمی (بدون فیلدهای جدید) با پیش‌فرض‌های سازگار ساخته می‌شود', async () => {
    const { service, discountRepo } = createService({
      productRepo: { find: jest.fn().mockResolvedValue([{ id: 10 }]) },
    });

    await service.create(dto({ productIds: [10] }));

    expect(discountRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stackable: false,
        stackPriority: 0,
        appliesToAllProducts: false,
      }),
    );
  });

  it('ترتیب مرحلهٔ منفی یا نامعتبر را رد می‌کند', async () => {
    const { service } = createService();

    await expect(
      service.create(dto({ appliesToAllProducts: true, stackPriority: -1 })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('درصد بیشتر از ۱۰۰ را رد می‌کند (ایجاد تخفیف نامعتبر ممکن نیست)', async () => {
    const { service } = createService();

    await expect(
      service.create(dto({ appliesToAllProducts: true, value: 120 })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('کد تخفیف فیلدهای متوالی را نادیده می‌گیرد', async () => {
    const { service, discountRepo } = createService();

    await service.create(
      dto({
        kind: DiscountKind.CODE,
        code: 'ABC',
        title: undefined,
        stackable: true,
        stackPriority: 5,
        appliesToAllProducts: true,
      }),
    );

    expect(discountRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: DiscountKind.CODE,
        stackable: false,
        stackPriority: 0,
        appliesToAllProducts: false,
      }),
    );
  });

  // ============================================================
  // ویرایش/حذف مرحله
  // ============================================================

  it('ویرایش مرحلهٔ دوم (درصد و اولویت) را ذخیره می‌کند', async () => {
    const existing = activeSale({
      id: 7,
      stackable: true,
      stackPriority: 1,
      appliesToAllProducts: true,
    });

    const { service, discountRepo } = createService();
    discountRepo.findOne.mockResolvedValue(existing);

    const saved = await service.update(7, {
      value: 25,
      stackPriority: 2,
      isActive: false,
    });

    expect(discountRepo.save).toHaveBeenCalled();
    expect(saved).toEqual(
      expect.objectContaining({
        value: 25,
        stackPriority: 2,
        isActive: false,
        stackable: true,
      }),
    );
  });

  it('حذف دامنهٔ محصولات بدون فعال‌کردن «همهٔ محصولات» خطا می‌دهد', async () => {
    const existing = activeSale({
      id: 7,
      products: [{ id: 10 }] as never,
      appliesToAllProducts: false,
    });

    const { service, discountRepo } = createService();
    discountRepo.findOne.mockResolvedValue(existing);

    await expect(service.update(7, { productIds: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  // ============================================================
  // قیمت‌گذاری سبد و دامنه
  // ============================================================

  it('priceCartLines روی مبلغ باقی‌مانده حساب می‌کند (۵۰٪ سپس ۲۰٪ = ۴٬۰۰۰٬۰۰۰)', async () => {
    const { service } = createService();

    const sales = [
      activeSale({
        id: 1,
        value: 50,
        stackable: true,
        stackPriority: 0,
        appliesToAllProducts: true,
      }),
      activeSale({
        id: 2,
        value: 20,
        stackable: true,
        stackPriority: 1,
        appliesToAllProducts: true,
      }),
    ];

    jest.spyOn(service, 'getActiveSales').mockResolvedValue(sales as never);

    const [line] = await service.priceCartLines([
      {
        productId: 1,
        quantity: 2,
        price: 10_000_000,
        categoryIds: [],
      },
    ]);

    expect(line.originalPrice).toBe(10_000_000);
    expect(line.unitPrice).toBe(4_000_000);
    expect(line.saleDiscountPerUnit).toBe(6_000_000);
    expect(line.isOnSale).toBe(true);
  });

  it('قیمت کارت محصول و قیمت سبد/سفارش دقیقاً یکسان است (منبع واحد)', async () => {
    const { service } = createService();

    const sales = [
      activeSale({
        id: 1,
        value: 50,
        stackable: true,
        stackPriority: 0,
        appliesToAllProducts: true,
      }),
      activeSale({
        id: 2,
        value: 20,
        stackable: true,
        stackPriority: 1,
        appliesToAllProducts: true,
      }),
    ];

    jest.spyOn(service, 'getActiveSales').mockResolvedValue(sales as never);

    const [line] = await service.priceCartLines([
      { productId: 1, quantity: 2, price: 10_000_000, categoryIds: [] },
    ]);

    const card = service.pickBestSale(sales as never, 1, [], 10_000_000);

    expect(line.unitPrice).toBe(card?.finalPrice);
    expect(line.saleDiscountPerUnit).toBe(card?.discountAmount);
    expect(line.unitPrice).toBe(4_000_000);
  });

  it('محصول خارج از دامنهٔ مرحلهٔ دوم فقط تخفیف مرحلهٔ اول را می‌گیرد', async () => {
    const { service } = createService();

    const sales = [
      activeSale({
        id: 1,
        value: 50,
        stackable: false,
        appliesToAllProducts: true,
      }),
      activeSale({
        id: 2,
        value: 20,
        stackable: true,
        appliesToAllProducts: false,
        products: [{ id: 42 }] as never,
      }),
    ];

    jest.spyOn(service, 'getActiveSales').mockResolvedValue(sales as never);

    const [line] = await service.priceCartLines([
      { productId: 1, quantity: 1, price: 10_000_000, categoryIds: [] },
    ]);

    expect(line.unitPrice).toBe(5_000_000);
    expect(line.sale?.id).toBe(1);
  });

  it('getActiveSaleScope دامنهٔ «همهٔ محصولات» را گزارش می‌کند', async () => {
    const { service } = createService();

    jest
      .spyOn(service, 'getActiveSales')
      .mockResolvedValue([
        activeSale({ id: 3, appliesToAllProducts: true }),
      ] as never);

    await expect(service.getActiveSaleScope()).resolves.toEqual(
      expect.objectContaining({ appliesToAll: true }),
    );
  });

  it('pickBestSale مرحله‌ها را با قیمت قبل/بعد برمی‌گرداند', () => {
    const { service } = createService();

    const result = service.pickBestSale(
      [
        activeSale({
          id: 1,
          value: 50,
          stackable: true,
          stackPriority: 0,
          appliesToAllProducts: true,
        }),
        activeSale({
          id: 2,
          value: 20,
          stackable: true,
          stackPriority: 1,
          appliesToAllProducts: true,
        }),
      ] as never,
      1,
      [],
      10_000_000,
    );

    expect(result).toEqual(
      expect.objectContaining({
        discountAmount: 6_000_000,
        finalPrice: 4_000_000,
        stacked: true,
        effectivePercent: 60,
      }),
    );

    expect(result?.stages).toHaveLength(2);
    expect(result?.stages[0]).toEqual(
      expect.objectContaining({
        priceBefore: 10_000_000,
        priceAfter: 5_000_000,
      }),
    );
    expect(result?.stages[1]).toEqual(
      expect.objectContaining({
        priceBefore: 5_000_000,
        priceAfter: 4_000_000,
      }),
    );
    // سازگاری: `discount` همچنان یک تخفیف واقعی است
    expect(result?.discount.id).toBe(1);
  });

  it('validUntil زودترین انقضای مراحل اعمال‌شده است', () => {
    const { service } = createService();

    const result = service.pickBestSale(
      [
        activeSale({
          id: 1,
          value: 50,
          stackable: true,
          stackPriority: 0,
          appliesToAllProducts: true,
          expiresAt: new Date('2027-06-01T00:00:00.000Z'),
        }),
        activeSale({
          id: 2,
          value: 20,
          stackable: true,
          stackPriority: 1,
          appliesToAllProducts: true,
          expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        }),
      ] as never,
      1,
      [],
      1_000_000,
    );

    expect(result?.validUntil).toBe('2026-12-01T00:00:00.000Z');
  });

  it('برای تخفیف‌های قدیمی خروجی دقیقاً مانند قبل است (بدون مرحلهٔ اضافه)', () => {
    const { service } = createService();

    const result = service.pickBestSale(
      [
        activeSale({
          id: 1,
          value: 20,
          stackable: false,
          appliesToAllProducts: true,
        }),
        activeSale({
          id: 2,
          value: 30,
          stackable: false,
          appliesToAllProducts: true,
        }),
      ] as never,
      1,
      [],
      1_000_000,
    );

    expect(result).toEqual(
      expect.objectContaining({
        discountAmount: 300_000,
        finalPrice: 700_000,
        stacked: false,
        effectivePercent: 30,
      }),
    );
    expect(result?.discount.id).toBe(2);
    expect(result?.stages).toHaveLength(1);
  });
});
