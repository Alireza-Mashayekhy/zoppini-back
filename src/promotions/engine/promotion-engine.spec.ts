import {
  FreeItemSelection,
  Promotion,
  PromotionRewardType,
  PromotionScope,
  PromotionType,
} from '../entities/promotion.entity';
import {
  evaluateBuyXGetY,
  evaluateCheaperItemPair,
  evaluatePromotion,
  expandCartLines,
  isProductInScope,
  isPromotionLive,
  orderDiscountCandidates,
  PromotionCartLine,
} from './promotion-engine';

/**
 * تست‌های موتور تخفیف «خرید زوج و تخفیف ارزان‌تر» و انواع دیگر.
 *
 * این تست‌ها منطقِ نهایی را قفل می‌کنند: همان اعدادی که تست می‌بیند، همان
 * اعدادی است که سبد/چک‌اوت/سفارش نشان می‌دهند (هر سه از همین موتور
 * استفاده می‌کنند).
 */

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 1,
    name: 'خرید ۲، ۵۰٪ تخفیف روی ارزان‌تر',
    internalDescription: null,
    type: PromotionType.CHEAPER_ITEM_PAIR,
    scope: PromotionScope.ALL,
    products: [],
    categories: [],
    excludedProducts: [],
    excludedCategories: [],
    rewardType: PromotionRewardType.PERCENTAGE,
    rewardValue: 50,
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
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    maxTotalUses: null,
    maxUsesPerCustomer: null,
    maxApplicationsPerCart: 1,
    canStack: false,
    stackable: false,
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Promotion;
}

function line(
  id: string,
  price: number,
  quantity: number,
  addedAt: number,
  overrides: Partial<PromotionCartLine> = {},
): PromotionCartLine {
  return {
    lineId: id,
    variantId: Number(String(id).replace(/\D/g, '')) || 1,
    productId: Number(String(id).replace(/\D/g, '')) || 1,
    categoryIds: [10],
    unitPrice: price,
    quantity,
    addedAt,
    ...overrides,
  };
}

const promo = makePromotion();

describe('cheaper-item promotion (buy an even number, discount the cheaper units)', () => {
  it('discounts exactly one unit with 2 eligible units', () => {
    const units = expandCartLines([
      line('a', 1_000_000, 1, 1),
      line('b', 2_000_000, 1, 2),
    ]);

    const result = evaluateCheaperItemPair(promo, units);

    expect(result.qualifies).toBe(true);
    // 50% of the cheaper item (1,000,000)
    expect(result.discountAmount).toBe(500_000);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].lineId).toBe('a');
    expect(result.allocations[0].amount).toBe(500_000);
    expect(result.allocations[0].discountedUnits).toBe(1);
  });

  it('does not discount an incomplete pair (3 units → 1 discounted unit)', () => {
    const units = expandCartLines([
      line('a', 1_000_000, 1, 1),
      line('b', 2_000_000, 1, 2),
      line('c', 3_000_000, 1, 3),
    ]);

    const result = evaluateCheaperItemPair(promo, units);

    expect(result.qualifies).toBe(true);
    expect(result.discountAmount).toBe(500_000);
    expect(
      result.allocations.reduce((sum, a) => sum + a.discountedUnits, 0),
    ).toBe(1);
    expect(result.allocations[0].lineId).toBe('a');
  });

  it('discounts the 2 cheapest units with 4 eligible units', () => {
    const units = expandCartLines([
      line('a', 1_000_000, 1, 1),
      line('b', 2_000_000, 1, 2),
      line('c', 3_000_000, 1, 3),
      line('d', 4_000_000, 1, 4),
    ]);

    const result = evaluateCheaperItemPair(promo, units);

    // 50% of 1,000,000 + 50% of 2,000,000
    expect(result.discountAmount).toBe(1_500_000);
    expect(
      result.allocations.reduce((sum, a) => sum + a.discountedUnits, 0),
    ).toBe(2);
    expect(result.allocations.map(a => a.lineId).sort()).toEqual(['a', 'b']);
  });

  it('discounts the 3 cheapest units with 6 eligible units', () => {
    const units = expandCartLines([
      line('a', 1_000_000, 1, 1),
      line('b', 2_000_000, 1, 2),
      line('c', 3_000_000, 1, 3),
      line('d', 4_000_000, 1, 4),
      line('e', 5_000_000, 1, 5),
      line('f', 6_000_000, 1, 6),
    ]);

    const result = evaluateCheaperItemPair(promo, units);

    // 50% × (1M + 2M + 3M)
    expect(result.discountAmount).toBe(3_000_000);
    expect(
      result.allocations.reduce((sum, a) => sum + a.discountedUnits, 0),
    ).toBe(3);
    expect(result.allocations.map(a => a.lineId).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('with 5 units discounts only floor(5/2) = 2 units', () => {
    const units = expandCartLines([
      line('a', 1_000_000, 1, 1),
      line('b', 2_000_000, 1, 2),
      line('c', 3_000_000, 1, 3),
      line('d', 4_000_000, 1, 4),
      line('e', 5_000_000, 1, 5),
    ]);

    const result = evaluateCheaperItemPair(promo, units);

    expect(
      result.allocations.reduce((sum, a) => sum + a.discountedUnits, 0),
    ).toBe(2);
    expect(result.discountAmount).toBe(1_500_000);
  });

  it('breaks equal-price ties in favour of the most recently added unit', () => {
    const units = expandCartLines([
      line('a', 2_500_000, 1, 100),
      line('b', 2_500_000, 1, 400),
    ]);

    const result = evaluateCheaperItemPair(promo, units);

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].lineId).toBe('b');
    expect(result.allocations[0].amount).toBe(1_250_000);
  });

  it('breaks equal-price ties across 4 units using recency', () => {
    const units = expandCartLines([
      line('a', 2_500_000, 1, 10),
      line('b', 2_500_000, 1, 40),
      line('c', 2_500_000, 1, 20),
      line('d', 2_500_000, 1, 30),
    ]);

    const result = evaluateCheaperItemPair(promo, units);

    // newest first: b(40), d(30) → two units discounted
    expect(result.allocations.map(a => a.lineId).sort()).toEqual(['b', 'd']);
    expect(result.discountAmount).toBe(2_500_000);
  });

  it('ignores ineligible items and only counts mixed eligible quantities', () => {
    const promotion = makePromotion({
      scope: PromotionScope.PRODUCTS,
      products: [{ id: 1 } as never],
    });

    const units = expandCartLines([
      // eligible: productId 1
      line('a', 1_000_000, 1, 1, { productId: 1 }),
      line('b', 3_000_000, 1, 2, { productId: 1 }),
      // ineligible
      line('c', 100_000, 1, 3, { productId: 2 }),
      line('d', 100_000, 1, 4, { productId: 2 }),
    ]);

    const result = evaluateCheaperItemPair(promotion, units);

    expect(result.discountAmount).toBe(500_000);
    expect(result.allocations.map(a => a.lineId).sort()).toEqual(['a']);
  });

  it('treats multiple quantities of the same product as separate units', () => {
    const units = expandCartLines([line('a', 1_000_000, 4, 1)]);

    const result = evaluateCheaperItemPair(promo, units);

    expect(result.discountAmount).toBe(1_000_000); // 2 units × 50%
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].lineId).toBe('a');
    expect(result.allocations[0].discountedUnits).toBe(2);
    expect(result.allocations[0].amount).toBe(1_000_000);
  });

  it('recalculates when quantities change', () => {
    const two = evaluateCheaperItemPair(
      promo,
      expandCartLines([line('a', 1_000_000, 2, 1)]),
    );
    const three = evaluateCheaperItemPair(
      promo,
      expandCartLines([line('a', 1_000_000, 3, 1)]),
    );
    const one = evaluateCheaperItemPair(
      promo,
      expandCartLines([line('a', 1_000_000, 1, 1)]),
    );

    expect(two.discountAmount).toBe(500_000);
    expect(three.discountAmount).toBe(500_000);
    expect(one.qualifies).toBe(false);
    expect(one.discountAmount).toBe(0);
    expect(one.reasons.length).toBeGreaterThan(0);
  });

  it('respects a configured pair size (3 units → 1 discount)', () => {
    const promotion = makePromotion({ pairSize: 3, rewardValue: 100 });
    const units = expandCartLines([
      line('a', 1_000_000, 1, 1),
      line('b', 2_000_000, 1, 2),
      line('c', 3_000_000, 1, 3),
    ]);

    const result = evaluateCheaperItemPair(promotion, units);

    expect(result.discountAmount).toBe(1_000_000);
    expect(result.allocations).toHaveLength(1);
  });

  it('never discounts more than the line is worth', () => {
    const units = expandCartLines([
      line('a', 1_000_000, 2, 1),
      line('b', 1_000_000, 2, 2),
    ]);

    const result = evaluateCheaperItemPair(
      makePromotion({ rewardValue: 150 }),
      units,
    );

    // 100% cap per unit even if admin enters 150%
    expect(result.discountAmount).toBe(2_000_000);
  });
});

describe('equal-price ordering helper', () => {
  it('orders by price, then newest, then unit index inside a line', () => {
    const units = expandCartLines([
      line('a', 1_000_000, 3, 10),
      line('b', 1_000_000, 1, 11),
      line('c', 500_000, 1, 1),
    ]);

    const ordered = orderDiscountCandidates(units);

    expect(ordered[0].lineId).toBe('c');
    // equal 1,000,000 units: a's last unit (addedAt 12) → index 2, then the
    // addedAt 11 tie where the later unit index (a#1) wins over line b#0.
    expect(ordered[1].lineId).toBe('a');
    expect(ordered[1].unitIndex).toBe(2);
    expect(ordered[2].lineId).toBe('a');
    expect(ordered[2].unitIndex).toBe(1);
    expect(ordered[3].lineId).toBe('b');
    expect(ordered[4].lineId).toBe('a');
  });
});

describe('buy X get Y same group', () => {
  it('makes the cheapest eligible units free once X+Y units exist', () => {
    const promotion = makePromotion({
      type: PromotionType.BUY_X_GET_Y_SAME_GROUP,
      rewardType: PromotionRewardType.FREE_ITEM,
      rewardValue: null,
      requiredQuantity: 2,
      freeQuantity: 1,
    });

    const units = expandCartLines([
      line('a', 500_000, 1, 1),
      line('b', 900_000, 1, 2),
      line('c', 1_200_000, 1, 3),
    ]);

    const result = evaluateBuyXGetY(promotion, units);

    expect(result.qualifies).toBe(true);
    expect(result.freeItemValue).toBe(500_000);
    expect(result.allocations[0].isFree).toBe(true);
    expect(result.allocations[0].lineId).toBe('a');
    expect(result.discountAmount).toBe(0);
  });

  it('needs X+Y units before granting anything', () => {
    const promotion = makePromotion({
      type: PromotionType.BUY_X_GET_Y_SAME_GROUP,
      requiredQuantity: 2,
      freeQuantity: 1,
    });

    const result = evaluateBuyXGetY(
      promotion,
      expandCartLines([line('a', 500_000, 1, 1), line('b', 900_000, 1, 2)]),
    );

    expect(result.qualifies).toBe(false);
    expect(result.freeItemValue).toBe(0);
    expect(result.message).toContain('1');
  });

  it('uses the most recent unit when prices are tied', () => {
    const promotion = makePromotion({
      type: PromotionType.BUY_X_GET_Y_SAME_GROUP,
      requiredQuantity: 1,
      freeQuantity: 1,
    });

    const result = evaluateBuyXGetY(
      promotion,
      expandCartLines([line('old', 700_000, 1, 5), line('new', 700_000, 1, 9)]),
    );

    expect(result.allocations[0].lineId).toBe('new');
  });
});

describe('promotion window', () => {
  const live = makePromotion();

  it('is live only between startsAt and expiresAt and when active', () => {
    expect(isPromotionLive(live, new Date('2026-06-01T00:00:00Z'))).toBe(true);
    expect(isPromotionLive(live, new Date('2024-12-31T23:59:59Z'))).toBe(false);
    expect(isPromotionLive(live, new Date('2030-01-01T00:00:01Z'))).toBe(false);
    expect(isPromotionLive({ ...live, isActive: false })).toBe(false);
  });

  it('expired promotions never discount', () => {
    const result = evaluatePromotion(
      live,
      expandCartLines([line('a', 100, 4, 1)]),
      { now: new Date('2031-01-01T00:00:00Z') },
    );

    expect(result.qualifies).toBe(false);
    expect(result.discountAmount).toBe(0);
    expect(result.reasons[0]).toContain('منقضی');
  });
});

describe('scope resolution', () => {
  it('matches all products when scope is ALL' , () => {
    expect(isProductInScope(promo, 999, [1, 2])).toBe(true);
  });

  it('matches selected products/categories and honours exclusions', () => {
    const scoped = makePromotion({
      scope: PromotionScope.CATEGORIES_AND_PRODUCTS,
      products: [{ id: 5 } as never],
      categories: [{ id: 10 } as never],
      excludedProducts: [{ id: 7 } as never],
      excludedCategories: [{ id: 11 } as never],
    });

    expect(isProductInScope(scoped, 5, [1])).toBe(true);
    expect(isProductInScope(scoped, 7, [1])).toBe(false);
    expect(isProductInScope(scoped, 123, [10])).toBe(true);
    expect(isProductInScope(scoped, 123, [11])).toBe(false);
    expect(isProductInScope(scoped, 124, [99])).toBe(false);
  });
});
