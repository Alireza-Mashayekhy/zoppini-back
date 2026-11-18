import { DiscountType } from './entities/discount.entity';
import {
  applySequentialDiscounts,
  calculateStageDiscount,
  isProductInSaleScope,
  isSaleActiveAt,
  resolveSequentialDiscountForProduct,
} from './sale-stacking';

type StackableSaleInput = {
  id: number;
  type?: DiscountType;
  value?: number;
  maxDiscountAmount?: number | null;
  stackable?: boolean;
  stackPriority?: number;
  appliesToAllProducts?: boolean;
  products?: { id: number }[];
  scopeCategoryIds?: Set<number>;
  isActive?: boolean;
  startsAt?: Date;
  expiresAt?: Date;
};

const START = new Date('2024-01-01T00:00:00.000Z');
const END = new Date('2099-01-01T00:00:00.000Z');

function sale(overrides: StackableSaleInput) {
  return {
    id: overrides.id,
    type: overrides.type ?? DiscountType.PERCENTAGE,
    value: overrides.value ?? 10,
    maxDiscountAmount: overrides.maxDiscountAmount ?? null,
    stackable: overrides.stackable ?? true,
    stackPriority: overrides.stackPriority ?? 0,
    appliesToAllProducts: overrides.appliesToAllProducts ?? true,
    products: overrides.products ?? [],
    scopeCategoryIds: overrides.scopeCategoryIds ?? new Set<number>(),
    isActive: overrides.isActive ?? true,
    startsAt: overrides.startsAt ?? START,
    expiresAt: overrides.expiresAt ?? END,
  };
}

const NOW = new Date('2026-11-18T12:00:00.000Z');

function resolve(sales: ReturnType<typeof sale>[], originalPrice: number) {
  return resolveSequentialDiscountForProduct(sales, {
    productId: 1,
    categoryIds: [],
    originalPrice,
    now: NOW,
  });
}

describe('sequential sale discounts engine', () => {
  // ============================================================
  // سناریوهای خواسته‌شده
  // ============================================================

  it('۱) محصول بدون تخفیف: هیچ مرحله‌ای اعمال نمی‌شود', () => {
    expect(resolve([], 10_000_000)).toBeNull();
  });

  it('۲) یک تخفیف ۵۰٪: قیمت ۵٬۰۰۰٬۰۰۰', () => {
    const result = resolve([sale({ id: 1, value: 50 })], 10_000_000);

    expect(result?.finalPrice).toBe(5_000_000);
    expect(result?.discountAmount).toBe(5_000_000);
    expect(result?.stacked).toBe(false);
    expect(result?.effectivePercent).toBe(50);
    expect(result?.stages).toHaveLength(1);
  });

  it('۳) دو تخفیف متوالی ۵۰٪ و ۲۰٪: قیمت ۴٬۰۰۰٬۰۰۰ و تخفیف مؤثر ۶۰٪ (نه ۷۰٪)', () => {
    const result = resolve(
      [
        sale({ id: 1, value: 50, stackPriority: 0 }),
        sale({ id: 2, value: 20, stackPriority: 1 }),
      ],
      10_000_000,
    );

    expect(result?.finalPrice).toBe(4_000_000);
    expect(result?.discountAmount).toBe(6_000_000);
    expect(result?.effectivePercent).toBe(60);
    expect(result?.stacked).toBe(true);
    expect(result?.stages).toHaveLength(2);

    expect(result?.stages[0].priceBefore).toBe(10_000_000);
    expect(result?.stages[0].priceAfter).toBe(5_000_000);
    expect(result?.stages[1].priceBefore).toBe(5_000_000);
    expect(result?.stages[1].priceAfter).toBe(4_000_000);
    expect(result?.stages[1].discountAmount).toBe(1_000_000);
  });

  it('۴) سه تخفیف متوالی ۵۰٪، ۲۰٪ و ۱۰٪: قیمت ۳٬۶۰۰٬۰۰۰', () => {
    const result = resolve(
      [
        sale({ id: 1, value: 50, stackPriority: 0 }),
        sale({ id: 2, value: 20, stackPriority: 1 }),
        sale({ id: 3, value: 10, stackPriority: 2 }),
      ],
      10_000_000,
    );

    expect(result?.finalPrice).toBe(3_600_000);
    expect(result?.discountAmount).toBe(6_400_000);
    expect(result?.effectivePercent).toBe(64);
    expect(result?.stages).toHaveLength(3);
  });

  it('۵) تخفیف دوم روی همهٔ محصولات اعمال می‌شود', () => {
    const globalStage = sale({ id: 2, value: 20, appliesToAllProducts: true });

    for (const productId of [1, 2, 3, 999]) {
      const result = resolveSequentialDiscountForProduct([globalStage], {
        productId,
        categoryIds: [],
        originalPrice: 1_000_000,
        now: NOW,
      });

      expect(result?.finalPrice).toBe(800_000);
    }
  });

  it('۶) تخفیف دوم فقط روی محصولات انتخاب‌شده اعمال می‌شود', () => {
    const selectedStage = sale({
      id: 2,
      value: 20,
      appliesToAllProducts: false,
      products: [{ id: 10 }, { id: 11 }],
    });

    const selected = resolveSequentialDiscountForProduct([selectedStage], {
      productId: 10,
      categoryIds: [],
      originalPrice: 1_000_000,
      now: NOW,
    });

    expect(selected?.finalPrice).toBe(800_000);

    const other = resolveSequentialDiscountForProduct([selectedStage], {
      productId: 12,
      categoryIds: [],
      originalPrice: 1_000_000,
      now: NOW,
    });

    expect(other).toBeNull();
  });

  it('۶-ب) تخفیف روی دسته‌بندی انتخاب‌شده (و زیرمجموعه‌هایش) اعمال می‌شود', () => {
    const stage = sale({
      id: 2,
      value: 20,
      appliesToAllProducts: false,
      scopeCategoryIds: new Set([5, 6, 7]),
    });

    expect(
      resolveSequentialDiscountForProduct([stage], {
        productId: 1,
        categoryIds: [7],
        originalPrice: 1_000_000,
        now: NOW,
      })?.finalPrice,
    ).toBe(800_000);

    expect(
      resolveSequentialDiscountForProduct([stage], {
        productId: 1,
        categoryIds: [8],
        originalPrice: 1_000_000,
        now: NOW,
      }),
    ).toBeNull();
  });

  it('۷) محصولی که مشمول تخفیف دوم نیست فقط تخفیف اول را می‌گیرد', () => {
    const first = sale({ id: 1, value: 50, appliesToAllProducts: true });
    const second = sale({
      id: 2,
      value: 20,
      appliesToAllProducts: false,
      products: [{ id: 99 }],
    });

    const result = resolveSequentialDiscountForProduct([first, second], {
      productId: 1,
      categoryIds: [],
      originalPrice: 10_000_000,
      now: NOW,
    });

    expect(result?.finalPrice).toBe(5_000_000);
    expect(result?.stages).toHaveLength(1);
    expect(result?.stages[0].discount.id).toBe(1);
  });

  it('۸) تخفیف غیرفعال یا منقضی‌شده در محاسبات لحاظ نمی‌شود', () => {
    const inactive = sale({ id: 1, value: 50, isActive: false });
    const expired = sale({
      id: 2,
      value: 30,
      expiresAt: new Date('2026-01-01'),
    });
    const notStarted = sale({
      id: 3,
      value: 25,
      startsAt: new Date('2027-01-01'),
    });

    expect(resolve([inactive, expired, notStarted], 1_000_000)).toBeNull();
    expect(isSaleActiveAt(inactive, NOW)).toBe(false);
    expect(isSaleActiveAt(expired, NOW)).toBe(false);
    expect(isSaleActiveAt(notStarted, NOW)).toBe(false);

    // مقدار خام tinyint از MySQL (0) هم غیرفعال است
    expect(
      isSaleActiveAt({ ...inactive, isActive: 0 as unknown as boolean }, NOW),
    ).toBe(false);
  });

  it('۸-ب) غیرفعال‌شدن فقط مرحلهٔ دوم: تخفیف مرحلهٔ اول سر جایش می‌ماند', () => {
    const result = resolve(
      [
        sale({ id: 1, value: 50, stackPriority: 0 }),
        sale({ id: 2, value: 20, stackPriority: 1, isActive: false }),
      ],
      10_000_000,
    );

    expect(result?.finalPrice).toBe(5_000_000);
    expect(result?.stages.map(stage => stage.discount.id)).toEqual([1]);
  });

  it('۹) حذف/تغییر یکی از مراحل، قیمت را با همان مرحله‌های باقی‌مانده بازمحاسبه می‌کند', () => {
    const first = sale({ id: 1, value: 50, stackPriority: 0 });
    const second = sale({ id: 2, value: 20, stackPriority: 1 });

    // حذف مرحلهٔ دوم
    expect(resolve([first], 10_000_000)?.finalPrice).toBe(5_000_000);

    // تغییر درصد مرحلهٔ دوم به ۱۰٪
    const changed = { ...second, value: 10 };

    expect(resolve([first, changed], 10_000_000)?.finalPrice).toBe(4_500_000);
  });

  it('۱۰) سفارش محصول دارای چند تخفیف: جمع تخفیف و قیمت نهایی سازگار است', () => {
    const result = resolve(
      [
        sale({ id: 1, value: 50, stackPriority: 0 }),
        sale({ id: 2, value: 20, stackPriority: 1 }),
      ],
      10_000_000,
    );

    const stageSum = (result?.stages ?? []).reduce(
      (sum, stage) => sum + stage.discountAmount,
      0,
    );

    expect(stageSum).toBe(result?.discountAmount);
    expect(10_000_000 - (result?.discountAmount ?? 0)).toBe(result?.finalPrice);
  });

  // ============================================================
  // سازگاری با رفتار قبلی
  // ============================================================

  it('تخفیف‌های قدیمی (غیر متوالی) مانند قبل فقط بهترین را اعمال می‌کنند', () => {
    const legacy50 = sale({ id: 1, value: 50, stackable: false });
    const legacy30 = sale({ id: 2, value: 30, stackable: false });

    const result = resolve([legacy50, legacy30], 10_000_000);

    expect(result?.finalPrice).toBe(5_000_000);
    expect(result?.discountAmount).toBe(5_000_000);
    expect(result?.stages).toHaveLength(1);
    expect(result?.stages[0].discount.id).toBe(1);
  });

  it('در تساوی مبلغ، تخفیف قدیمی با شناسهٔ کوچک‌تر انتخاب می‌شود (پایدار)', () => {
    const result = resolve(
      [
        sale({ id: 8, value: 20, stackable: false }),
        sale({ id: 3, value: 20, stackable: false }),
      ],
      1_000_000,
    );

    expect(result?.stages[0].discount.id).toBe(3);
  });

  it('تخفیف قدیمی + مرحلهٔ متوالی: قدیمی پایه است و مرحله روی باقی‌مانده اعمال می‌شود', () => {
    const legacy10 = sale({ id: 1, value: 10, stackable: false });
    const stack50 = sale({ id: 2, value: 50, stackable: true });

    const result = resolve([legacy10, stack50], 10_000_000);

    expect(result?.finalPrice).toBe(4_500_000);
    expect(result?.stages.map(stage => stage.discount.id)).toEqual([1, 2]);
  });

  it('ترتیب اعمال بر اساس stackPriority است، نه شناسه', () => {
    const later = sale({ id: 4, value: 10, stackPriority: 5 });
    const earlier = sale({ id: 9, value: 50, stackPriority: 1 });

    const result = resolve([later, earlier], 1_000_000);

    expect(result?.stages.map(stage => stage.discount.id)).toEqual([9, 4]);
    expect(result?.finalPrice).toBe(450_000);
  });

  it('یک تخفیف تکراری در ورودی فقط یک بار اعمال می‌شود', () => {
    const duplicated = sale({ id: 1, value: 50 });

    const result = resolve([duplicated, { ...duplicated }], 1_000_000);

    expect(result?.stages).toHaveLength(1);
    expect(result?.finalPrice).toBe(500_000);
  });

  // ============================================================
  // اعتبارسنجی/کران‌ها
  // ============================================================

  it('مبلغ تخفیف هر مرحله از باقی‌مانده بیشتر نمی‌شود و قیمت منفی نمی‌شود', () => {
    const result = resolve(
      [
        sale({ id: 1, value: 100 }),
        sale({ id: 2, value: 100 }),
        sale({ id: 3, type: DiscountType.FIXED, value: 5_000_000 }),
      ],
      1_000_000,
    );

    expect(result?.finalPrice).toBe(0);
    expect(result?.discountAmount).toBe(1_000_000);

    for (const stage of result?.stages ?? []) {
      expect(stage.priceAfter).toBeGreaterThanOrEqual(0);
      expect(stage.discountAmount).toBeLessThanOrEqual(stage.priceBefore);
    }
  });

  it('درصد نامعتبر (بیش از ۱۰۰ یا منفی) باعث تخفیف بیشتر از مبلغ یا منفی نمی‌شود', () => {
    expect(calculateStageDiscount(sale({ id: 1, value: 150 }), 1_000)).toBe(
      1_000,
    );
    expect(calculateStageDiscount(sale({ id: 1, value: -20 }), 1_000)).toBe(0);

    const result = resolve([sale({ id: 1, value: 150 })], 1_000);

    expect(result?.finalPrice).toBe(0);
    expect(result?.effectivePercent).toBe(100);
  });

  it('سقف مبلغ تخفیف (maxDiscountAmount) در هر مرحله رعایت می‌شود', () => {
    const capped = sale({
      id: 1,
      value: 50,
      maxDiscountAmount: 100_000,
    });

    expect(applySequentialDiscounts(1_000_000, [capped]).finalPrice).toBe(
      900_000,
    );
  });

  it('تخفیف مبلغ ثابت روی مبلغ باقی‌مانده اعمال می‌شود', () => {
    const result = resolve(
      [
        sale({ id: 1, value: 50 }),
        sale({ id: 2, type: DiscountType.FIXED, value: 1_000_000 }),
      ],
      10_000_000,
    );

    expect(result?.finalPrice).toBe(4_000_000);
    expect(result?.stages[1].discountAmount).toBe(1_000_000);
  });

  it('محصول غیرمشمول حتی با وجود تخفیف سراسری دیگر، فقط دامنهٔ خودش را می‌گیرد', () => {
    const scoped = sale({
      id: 2,
      value: 20,
      appliesToAllProducts: false,
      products: [{ id: 3 }],
    });

    // `isProductInSaleScope` مستقل از وضعیت فعال بودن بررسی می‌شود
    expect(isProductInSaleScope(scoped, 3, [])).toBe(true);
    expect(isProductInSaleScope(scoped, 4, [])).toBe(false);
  });
});
