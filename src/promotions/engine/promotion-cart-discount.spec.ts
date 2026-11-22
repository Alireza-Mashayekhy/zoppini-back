import {
  CartDiscountBase,
  FreeItemSelection,
  Promotion,
  PromotionRewardType,
  PromotionScope,
  PromotionType,
} from '../entities/promotion.entity';
import { coordinatePromotions } from './promotion-coordinator';
import {
  distributeProportionalCap,
  evaluatePromotion,
  expandCartLines,
  PromotionCartLine,
} from './promotion-engine';

/**
 * تست‌های «صلاحیت محصولات دارای تخفیف» و «مبنای محاسبهٔ تخفیف سبد».
 *
 * این تست‌ها دقیقاً همان سناریوهای توافق‌شده را قفل می‌کنند:
 *   P = قیمت فهرست، D = تخفیف سطح محصول، C = تخفیف سبد
 *   - متوالی (discounted_price):  Final = P × (1 − D) × (1 − C)
 *   - جمعی  (original_price):    Final = P × (1 − D − C)
 *
 * قیمت نهایی توسط همین موتور + calculateCheckoutTotals ساخته می‌شود؛
 * اینجا برای خوانایی، «پرداختی» از روی قیمت فروش و تخفیف سبد محاسبه می‌شود.
 */

const P = 10_000_000;
const SALE_50 = 5_000_000; // P × (1 − 50%)
const SALE_90 = 1_000_000; // P × (1 − 90%)

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 1,
    name: 'تخفیف عمومی سبد',
    internalDescription: null,
    type: PromotionType.CART_DISCOUNT,
    scope: PromotionScope.ALL,
    products: [],
    categories: [],
    excludedProducts: [],
    excludedCategories: [],
    rewardType: PromotionRewardType.PERCENTAGE,
    rewardValue: 20,
    maxDiscountAmount: null,
    minQuantity: 0,
    minCartValue: 0,
    pairSize: 2,
    discountEveryExtraUnit: false,
    requiredQuantity: 0,
    freeQuantity: 0,
    rewardScope: null,
    rewardProducts: [],
    rewardCategories: [],
    suggestedProduct: null,
    suggestedProductId: null,
    suggestedCategory: null,
    suggestedCategoryId: null,
    rewardQuantity: 1,
    freeItemSelection: FreeItemSelection.AUTO,
    autoAddReward: false,
    requiresCustomerAcceptance: true,
    removeRewardWhenTriggerRemoved: true,
    isActive: true,
    startsAt: new Date('2025-01-01T00:00:00Z'),
    expiresAt: new Date('2035-01-01T00:00:00Z'),
    maxTotalUses: null,
    maxUsesPerCustomer: null,
    maxApplicationsPerCart: 1,
    canStack: true,
    stackable: true,
    priority: 0,
    badgeText: null,
    customerDescription: null,
    showBadgeOnProductCard: false,
    showBadgeOnProductPage: false,
    showPreCartPopup: false,
    popupTitle: null,
    popupDescription: null,
    popupAcceptLabel: null,
    popupDismissLabel: null,
    popupSuggestedProductId: null,
    popupSuggestedProduct: null,
    popupSuggestedCategoryId: null,
    popupSuggestedCategory: null,
    applyToDiscountedProducts: false,
    cartDiscountBase: CartDiscountBase.DISCOUNTED_PRICE,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Promotion;
}

function line(
  id: number,
  salePrice: number,
  listPrice: number,
  quantity: number,
): PromotionCartLine {
  return {
    lineId: id,
    variantId: id,
    productId: id,
    categoryIds: [10],
    unitPrice: salePrice,
    listPrice,
    quantity,
    addedAt: id,
  };
}

/** یک ردیف دارای تخفیف سطح محصول ۵۰٪ */
const discountedLine = (id = 1, quantity = 1) => line(id, SALE_50, P, quantity);
/** یک ردیف بدون تخفیف سطح محصول */
const plainLine = (id = 2, price = 4_000_000, quantity = 1) =>
  line(id, price, price, quantity);

function payableOf(
  lines: PromotionCartLine[],
  discount: number,
  saleTotal: number,
) {
  return Math.max(0, saleTotal - discount);
}

describe('سناریوی A — پرداخت متوالی روی قیمت پس از تخفیف محصول', () => {
  it('P=10,000,000 D=50% C=20% ⇒ نهایی 4,000,000', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: true,
      cartDiscountBase: CartDiscountBase.DISCOUNTED_PRICE,
    });

    const lines = [discountedLine()];
    const units = expandCartLines(lines);
    const result = evaluatePromotion(promotion, units);

    // 20% of 5,000,000 = 1,000,000
    expect(result.qualifies).toBe(true);
    expect(result.discountAmount).toBe(1_000_000);

    const saleTotal = SALE_50;
    expect(payableOf(lines, result.discountAmount, saleTotal)).toBe(4_000_000);
    expect(result.meta).toEqual({
      cartDiscountBase: CartDiscountBase.DISCOUNTED_PRICE,
      applyToDiscountedProducts: true,
    });
  });
});

describe('سناریوی B — پرداخت جمعی روی قیمت فهرست', () => {
  it('P=10,000,000 D=50% C=20% ⇒ نهایی 3,000,000', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: true,
      cartDiscountBase: CartDiscountBase.ORIGINAL_PRICE,
    });

    const units = expandCartLines([discountedLine()]);
    const result = evaluatePromotion(promotion, units);

    // 20% of 10,000,000 = 2,000,000
    expect(result.qualifies).toBe(true);
    expect(result.discountAmount).toBe(2_000_000);
    expect(payableOf([], result.discountAmount, SALE_50)).toBe(3_000_000);
  });

  it('کمیت > ۱: تخفیف جمعی با احتساب تعداد واحدها', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: true,
      cartDiscountBase: CartDiscountBase.ORIGINAL_PRICE,
    });

    const units = expandCartLines([discountedLine(1, 3)]);
    const result = evaluatePromotion(promotion, units);

    // 20% of 30,000,000 = 6,000,000
    expect(result.discountAmount).toBe(6_000_000);
    expect(result.allocations[0]?.discountedUnits).toBe(3);
  });
});

describe('سناریوی C — خاموش‌بودن صلاحیت محصولات دارای تخفیف', () => {
  it('کالای دارای تخفیف هیچ تخفیف سبدی نمی‌گیرد (پیش‌فرض)', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: false,
    });

    const units = expandCartLines([discountedLine()]);
    const result = evaluatePromotion(promotion, units);

    expect(result.qualifies).toBe(false);
    expect(result.discountAmount).toBe(0);
    expect(result.reasons.join(' ')).toContain('تخفیف');
  });

  it('کالای دارای تخفیف با خاموش‌بودن تنظیمات، ولی پروموشن ثابت این تخفیف پیش‌فرض است', () => {
    // پیش‌فرض entity: applyToDiscountedProducts = false
    const promotion = makePromotion({});

    expect(promotion.applyToDiscountedProducts).toBe(false);
    expect(promotion.cartDiscountBase).toBe(CartDiscountBase.DISCOUNTED_PRICE);
  });
});

describe('سناریوی D — کالای بدون تخفیف، رفتار قبلی دست‌نخورده', () => {
  it('کالای بدون تخفیف با سوییچ خاموش هم تخفیف می‌گیرد', () => {
    const promotion = makePromotion({ applyToDiscountedProducts: false });

    const units = expandCartLines([plainLine(2, 4_000_000)]);
    const result = evaluatePromotion(promotion, units);

    expect(result.qualifies).toBe(true);
    expect(result.discountAmount).toBe(800_000); // 20% از 4,000,000
  });

  it('کالای بدون تخفیف با سوییچ روشن هم تخفیف می‌گیرد', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: true,
      cartDiscountBase: CartDiscountBase.ORIGINAL_PRICE,
    });

    const units = expandCartLines([plainLine(2, 4_000_000)]);
    const result = evaluatePromotion(promotion, units);

    expect(result.discountAmount).toBe(800_000); // مبنا = فهرست = فروش
  });
});

describe('سناریوی E — سبد مختلط', () => {
  it('سوییچ خاموش: فقط ردیف بدون تخفیف تخفیف می‌گیرد', () => {
    const promotion = makePromotion({ applyToDiscountedProducts: false });

    const units = expandCartLines([discountedLine(1), plainLine(2, 4_000_000)]);
    const result = evaluatePromotion(promotion, units);

    expect(result.discountAmount).toBe(800_000);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]?.lineId).toBe(2);
  });

  it('سوییچ روشن + مبنای اصلی: هر دو ردیف روی قیمت فهرست محاسبه می‌شوند', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: true,
      cartDiscountBase: CartDiscountBase.ORIGINAL_PRICE,
    });

    const units = expandCartLines([
      discountedLine(1), // مبنا 10,000,000 / بودجه 5,000,000
      plainLine(2, 4_000_000), // مبنا 4,000,000 / بودجه 4,000,000
    ]);
    const result = evaluatePromotion(promotion, units);

    // 20% از 14,000,000 = 2,800,000
    expect(result.discountAmount).toBe(2_800_000);

    const allocA = result.allocations.find(a => a.lineId === 1);
    const allocB = result.allocations.find(a => a.lineId === 2);

    expect(allocA?.amount).toBe(2_000_000); // 10/14 از 2.8M
    expect(allocB?.amount).toBe(800_000); // 4/14 از 2.8M

    // قیمت نهایی ردیف‌ها
    expect(SALE_50 - (allocA?.amount ?? 0)).toBe(3_000_000); // P(1−.5−.2)
    expect(4_000_000 - (allocB?.amount ?? 0)).toBe(3_200_000);
  });

  it('سوییچ روشن + مبنای متوالی: هر دو ردیف روی قیمت پس از تخفیف محاسبه می‌شوند', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: true,
      cartDiscountBase: CartDiscountBase.DISCOUNTED_PRICE,
    });

    const units = expandCartLines([
      discountedLine(1), // مبنا 5,000,000
      plainLine(2, 4_000_000), // مبنا 4,000,000
    ]);
    const result = evaluatePromotion(promotion, units);

    // 20% از 9,000,000 = 1,800,000
    expect(result.discountAmount).toBe(1_800_000);
    expect(result.allocations.find(a => a.lineId === 1)?.amount).toBe(
      1_000_000,
    );
    expect(result.allocations.find(a => a.lineId === 2)?.amount).toBe(800_000);
  });
});

describe('سناریوی F — ترکیب تخفیف از ۱۰۰٪ نمی‌گذرد', () => {
  it('D=90% C=20% با مبنای اصلی: قیمت نهایی صفر و نه منفی', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: true,
      cartDiscountBase: CartDiscountBase.ORIGINAL_PRICE,
    });

    const units = expandCartLines([line(1, SALE_90, P, 1)]);
    const result = evaluatePromotion(promotion, units);

    // خام 20% از 10M = 2M؛ باقیماندهٔ قابل پرداخت = 1M
    expect(result.discountAmount).toBe(1_000_000);
    expect(payableOf([], result.discountAmount, SALE_90)).toBe(0);
  });

  it('D=90% C=20% با مبنای متوالی: قیمت منفی نمی‌شود', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: true,
      cartDiscountBase: CartDiscountBase.DISCOUNTED_PRICE,
    });

    const units = expandCartLines([line(1, SALE_90, P, 1)]);
    const result = evaluatePromotion(promotion, units);

    expect(result.discountAmount).toBe(200_000); // 20% از 1M
    expect(payableOf([], result.discountAmount, SALE_90)).toBe(800_000);
  });

  it('مبلغ ثابت بزرگ‌تر از باقیماندهٔ رسید: فقط تا صفر کم می‌شود', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: true,
      cartDiscountBase: CartDiscountBase.ORIGINAL_PRICE,
      rewardType: PromotionRewardType.FIXED,
      rewardValue: 8_000_000,
    });

    const units = expandCartLines([discountedLine(1)]); // باقیمانده 5M
    const result = evaluatePromotion(promotion, units);

    expect(result.discountAmount).toBe(5_000_000);
    expect(payableOf([], result.discountAmount, SALE_50)).toBe(0);
  });

  it('سقف تخفیف ادمین (maxDiscountAmount) همچنان اعمال می‌شود', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: true,
      cartDiscountBase: CartDiscountBase.ORIGINAL_PRICE,
      rewardValue: 50,
      maxDiscountAmount: 1_500_000,
    });

    const units = expandCartLines([plainLine(2, 8_000_000)]);
    const result = evaluatePromotion(promotion, units);

    expect(result.discountAmount).toBe(1_500_000);
  });
});

describe('تقسیم متناسب با سقف ردیف (water-filling)', () => {
  it('جمع خروجی برابر min(discount, مجموع سقف‌ها) است', () => {
    const result = distributeProportionalCap(100, [
      { key: 'a', weight: 1, cap: 10 },
      { key: 'b', weight: 1, cap: 1000 },
    ]);

    expect(result.get('a')).toBe(10); // سقف‌خورده
    expect(result.get('b')).toBe(90); // باقیمانده به خط باز تخصیص یافت
    expect((result.get('a') ?? 0) + (result.get('b') ?? 0)).toBe(100);
  });

  it('گرد کردن هرگز مجموع را از مبلغ هدف بیشتر نمی‌کند', () => {
    const result = distributeProportionalCap(100, [
      { key: 'a', weight: 1, cap: 1000 },
      { key: 'b', weight: 1, cap: 1000 },
      { key: 'c', weight: 1, cap: 1000 },
    ]);

    const sum = ['a', 'b', 'c'].reduce(
      (acc, key) => acc + (result.get(key) ?? 0),
      0,
    );

    expect(sum).toBe(100);
  });
});

describe('ادغام در هماهنگ‌کننده (یک بار روی هر ردیف)', () => {
  it('تخفیف سبد دو بار روی یک ردیف اعمال نمی‌شود و متا در اسنپ‌شات می‌ماند', () => {
    const promotion = makePromotion({
      applyToDiscountedProducts: true,
      cartDiscountBase: CartDiscountBase.ORIGINAL_PRICE,
      canStack: true,
    });

    const result = coordinatePromotions({
      promotions: [promotion],
      lines: [discountedLine(1)],
    });

    const evaluation = result.applied.find(item => item.promotionId === 1);

    expect(evaluation?.discountAmount).toBe(2_000_000);
    expect(evaluation?.meta?.cartDiscountBase).toBe(
      CartDiscountBase.ORIGINAL_PRICE,
    );
    expect(evaluation?.meta?.applyToDiscountedProducts).toBe(true);
  });
});
