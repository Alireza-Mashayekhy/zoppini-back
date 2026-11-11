import { calculateCheckoutTotals } from 'src/order/checkout-pricing';

import {
  FreeItemSelection,
  Promotion,
  PromotionRewardType,
  PromotionScope,
  PromotionType,
} from './entities/promotion.entity';
import { coordinatePromotions } from './engine/promotion-coordinator';
import {
  evaluatePromotion,
  expandCartLines,
  PromotionCartLine,
} from './engine/promotion-engine';

/**
 * تست‌های یکپارچگی بین سه سطح:
 * ۱. محاسبهٔ موتور (همان چیزی که سبد و پاپ‌آپ نشان می‌دهند)
 * ۲. جمع‌های چک‌اوت (calculateCheckoutTotals)
 * ۳. اسنپ‌شات سفارش (همان اعدادی که در فاکتور و پشتیبانی ذخیره می‌شود)
 *
 * هدف: هیچ‌گاه سه عدد متفاوت در سه صفحه نبینیم.
 */

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 1,
    name: 'پروموشن',
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
  overrides: Partial<PromotionCartLine> = {},
): PromotionCartLine {
  return {
    lineId: id,
    variantId: 1,
    productId: 100,
    categoryIds: [10],
    unitPrice: price,
    quantity,
    addedAt: 1,
    ...overrides,
  };
}

const now = new Date('2026-06-01T00:00:00Z');

describe('cart, checkout and order totals match exactly', () => {
  it('keeps cart total, checkout total and order total identical', () => {
    const lines = [
      line('line-1', 1_200_000, 2, { variantId: 11 }),
      line('line-2', 2_400_000, 2, { variantId: 12 }),
    ];

    const result = coordinatePromotions({
      promotions: [makePromotion()],
      lines,
      options: { now },
    });

    // سبد: 50% روی دو واحد ارزان‌تر (1.2M + 1.2M)
    expect(result.totalDiscount).toBe(1_200_000);

    const promotionByLine = new Map(
      result.applied
        .flatMap(evaluation => evaluation.allocations)
        .map(allocation => [String(allocation.lineId), allocation.amount]),
    );

    const checkout = calculateCheckoutTotals({
      lines: lines.map(entry => ({
        lineId: entry.lineId,
        variantId: entry.variantId,
        productId: entry.productId,
        quantity: entry.quantity,
        originalPrice: entry.unitPrice,
        salePrice: entry.unitPrice,
        promotionDiscount: promotionByLine.get(String(entry.lineId)) ?? 0,
      })),
      shippingCost: 170_000,
    });

    expect(checkout.consistency.ok).toBe(true);
    expect(checkout.promotionDiscount).toBe(result.totalDiscount);
    expect(checkout.originalPrice).toBe(7_200_000);
    expect(checkout.finalPrice).toBe(7_200_000 - 1_200_000 + 170_000);

    // صورت‌حساب/سفارش: جمع خطوط = جمع چک‌اوت
    const orderItemTotals = checkout.lines.reduce(
      (sum, entry) => sum + entry.payableTotal,
      0,
    );
    expect(orderItemTotals).toBe(checkout.originalPrice - checkout.promotionDiscount);
  });

  it('keeps totals identical when a free reward line exists', () => {
    const promotion = makePromotion({
      id: 5,
      type: PromotionType.BUY_TRIGGER_GET_REWARD,
      rewardType: PromotionRewardType.FREE_ITEM,
      rewardValue: null,
      minQuantity: 1,
      suggestedProductId: 200,
      autoAddReward: true,
      requiresCustomerAcceptance: false,
    });

    const lines = [
      line('suit', 5_000_000, 1, { variantId: 21, productId: 100 }),
      line('shirt', 900_000, 1, {
        variantId: 22,
        productId: 200,
        isFreeReward: true,
        rewardPromotionId: 5,
      }),
    ];

    const result = coordinatePromotions({
      promotions: [promotion],
      lines,
      options: { now },
    });

    expect(result.totalFreeItemValue).toBe(900_000);
    expect(result.totalDiscount).toBe(0);

    const freeAllocation = result.applied[0].allocations.find(
      allocation => allocation.isFree,
    );

    const checkout = calculateCheckoutTotals({
      lines: lines.map(entry => ({
        lineId: entry.lineId,
        variantId: entry.variantId,
        productId: entry.productId,
        quantity: entry.quantity,
        originalPrice: entry.unitPrice,
        salePrice: entry.unitPrice,
        // ردیف هدیه با کل مبلغ رایگان می‌شود
        promotionDiscount: entry.isFreeReward
          ? (freeAllocation?.amount ?? entry.unitPrice)
          : 0,
        isFreeReward: entry.isFreeReward,
        promotionRewardId: entry.rewardPromotionId,
      })),
      shippingCost: 0,
    });

    expect(checkout.consistency.ok).toBe(true);
    expect(checkout.freeItemValue).toBe(900_000);
    expect(checkout.finalPrice).toBe(5_000_000);
    expect(
      checkout.lines.find(entry => entry.lineId === 'shirt')?.payableTotal,
    ).toBe(0);
  });
});

describe('equal-price tie-break is consistent across surfaces', () => {
  it('displays the same discounted line in cart, popup suggestion and order', () => {
    const lines = [
      line('first', 1_000_000, 1, { variantId: 31 }),
      line('second', 1_000_000, 1, { variantId: 32 }),
    ];

    const evaluation = evaluatePromotion(
      makePromotion(),
      expandCartLines(lines),
      { now },
    );

    expect(evaluation.allocations).toHaveLength(1);
    // newer cart line wins the tie
    expect(evaluation.allocations[0].lineId).toBe('second');
    expect(evaluation.discountAmount).toBe(500_000);
  });
});

describe('mixed eligible and ineligible items across surfaces', () => {
  it('discounts only eligible items and keeps totals aligned', () => {
    const promotion = makePromotion({
      scope: PromotionScope.CATEGORIES,
      categories: [{ id: 10 } as never],
    });

    const lines = [
      line('eligible-1', 1_000_000, 1, { categoryIds: [10] }),
      line('eligible-2', 2_000_000, 1, { categoryIds: [10] }),
      line('other', 5_000_000, 1, { categoryIds: [99] }),
    ];

    const result = coordinatePromotions({
      promotions: [promotion],
      lines,
      options: { now },
    });

    // فقط یک جفت مشمول وجود دارد ⇒ فقط یک واحد (ارزان‌تر) تخفیف می‌گیرد
    expect(result.totalDiscount).toBe(500_000);

    const checkout = calculateCheckoutTotals({
      lines: lines.map(entry => ({
        lineId: entry.lineId,
        variantId: entry.variantId,
        productId: entry.productId,
        quantity: entry.quantity,
        originalPrice: entry.unitPrice,
        salePrice: entry.unitPrice,
        promotionDiscount:
          result.applied[0].allocations.find(
            allocation => String(allocation.lineId) === String(entry.lineId),
          )?.amount ?? 0,
      })),
      shippingCost: 0,
    });

    expect(checkout.consistency.ok).toBe(true);
    expect(checkout.promotionDiscount).toBe(500_000);
    // the ineligible 5,000,000 line keeps its full price
    expect(
      checkout.lines.find(entry => entry.lineId === 'other')?.payableTotal,
    ).toBe(5_000_000);
  });
});

describe('expiration and out-of-stock are reported to the customer', () => {
  it('bubbles expiry into notices with a customer-facing sentence', () => {
    const result = coordinatePromotions({
      promotions: [
        makePromotion({
          expiresAt: new Date('2026-05-01T00:00:00Z'),
        }),
      ],
      lines: [line('a', 1_000_000, 4)],
      options: { now },
    });

    expect(result.totalDiscount).toBe(0);
    expect(result.notices.join(' ')).toContain('منقضی');
  });

  it('blocks rewards that exceed stock but keeps totals consistent', () => {
    const promotion = makePromotion({
      id: 7,
      type: PromotionType.BUY_TRIGGER_GET_REWARD,
      rewardType: PromotionRewardType.FREE_ITEM,
      rewardValue: null,
      minQuantity: 1,
      suggestedProductId: 200,
      autoAddReward: true,
      requiresCustomerAcceptance: false,
    });

    const result = coordinatePromotions({
      promotions: [promotion],
      lines: [line('suit', 5_000_000, 1, { productId: 100 })],
      options: { now, variantStock: () => 0 },
    });

    expect(result.applied).toHaveLength(0);
    expect(result.totalFreeItemValue).toBe(0);
    expect(result.rejected[0].reasons.join(' ')).toContain('انبار');
  });
});

describe('stacking enabled vs disabled totals', () => {
  const promotions = [
    makePromotion({ id: 1, canStack: true }),
    makePromotion({
      id: 2,
      type: PromotionType.CART_DISCOUNT,
      rewardValue: 10,
      canStack: true,
    }),
  ];

  const lines = [line('a', 1_000_000, 2)];

  it('charging less when stacking is on than when it is off', () => {
    const on = coordinatePromotions({
      promotions,
      lines,
      options: { now, allowStacking: true },
    });
    const off = coordinatePromotions({
      promotions,
      lines,
      options: { now, allowStacking: false },
    });

    expect(on.totalDiscount).toBeGreaterThan(off.totalDiscount);
    expect(off.applied).toHaveLength(1);

    const onCheckout = calculateCheckoutTotals({
      lines: lines.map(entry => ({
        lineId: entry.lineId,
        variantId: entry.variantId,
        productId: entry.productId,
        quantity: entry.quantity,
        originalPrice: entry.unitPrice,
        salePrice: entry.unitPrice,
      })),
      shippingCost: 0,
      codeDiscount: 0,
    });

    // هر دو مسیر با همان قیمت پایه شروع می‌کنند
    expect(onCheckout.originalPrice).toBe(2_000_000);
  });
});
