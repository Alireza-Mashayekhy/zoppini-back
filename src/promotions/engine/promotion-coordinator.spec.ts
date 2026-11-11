import {
  FreeItemSelection,
  Promotion,
  PromotionRewardType,
  PromotionScope,
  PromotionType,
} from '../entities/promotion.entity';
import { coordinatePromotions } from './promotion-coordinator';
import { PromotionCartLine } from './promotion-engine';

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

describe('promotion stacking', () => {
  const cheaper = makePromotion({
    id: 1,
    name: 'ارزان‌تر ۵۰٪',
    canStack: true,
  });

  const spend = makePromotion({
    id: 2,
    name: 'تخفیف ۱۰٪ سبد',
    type: PromotionType.CART_DISCOUNT,
    rewardValue: 10,
    canStack: true,
  });

  const lines = [line('a', 2_000_000, 2)];

  it('applies both stackable promotions when stacking is enabled', () => {
    const result = coordinatePromotions({
      promotions: [cheaper, spend],
      lines,
      options: { allowStacking: true, now },
    });

    expect(result.applied.map(item => item.promotionId).sort()).toEqual([
      1, 2,
    ]);
    // cheaper: 50% of 2,000,000 = 1,000,000 → cart discount base 4,000,000 = 400,000
    expect(result.totalDiscount).toBe(1_400_000);
  });

  it('applies only the best promotion when stacking is disabled', () => {
    const result = coordinatePromotions({
      promotions: [cheaper, spend],
      lines,
      options: { allowStacking: false, now },
    });

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].promotionId).toBe(1);
    expect(result.totalDiscount).toBe(1_000_000);
    expect(
      result.rejected.some(item => item.reasons.join(' ').includes('ترکیب')),
    ).toBe(true);
  });

  it('never combines two non-stackable promotions', () => {
    const second = makePromotion({
      id: 3,
      name: 'تخفیف ۲۰٪ سبد',
      type: PromotionType.CART_DISCOUNT,
      rewardValue: 20,
      canStack: false,
    });

    const result = coordinatePromotions({
      promotions: [{ ...cheaper, canStack: false }, second],
      lines,
      options: { allowStacking: true, now },
    });

    // both are non-stackable on the same cart: only the better one applies
    expect(result.applied).toHaveLength(1);
    // 50% of one unit (1,000,000) beats 20% of the cart (800,000)
    expect(result.applied[0].promotionId).toBe(1);
    expect(
      result.rejected.some(item => item.promotionId === 3),
    ).toBe(true);
  });
});

describe('expiration', () => {
  it('drops an expired promotion and explains why', () => {
    const expired = makePromotion({
      id: 9,
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = coordinatePromotions({
      promotions: [expired],
      lines: [line('a', 1_000_000, 2)],
      options: { now },
    });

    expect(result.applied).toHaveLength(0);
    expect(result.totalDiscount).toBe(0);
    expect(result.notices.join(' ')).toContain('منقضی');
  });
});

describe('trigger removal removes the free reward', () => {
  const promo = makePromotion({
    id: 11,
    type: PromotionType.BUY_TRIGGER_GET_REWARD,
    rewardType: PromotionRewardType.FREE_ITEM,
    rewardValue: null,
    minQuantity: 1,
    suggestedProductId: 200,
    rewardQuantity: 1,
    autoAddReward: true,
    requiresCustomerAcceptance: false,
  });

  it('keeps the free reward while the trigger is in the cart', () => {
    const result = coordinatePromotions({
      promotions: [promo],
      lines: [
        line('suit', 5_000_000, 1, { productId: 100 }),
        line('shirt', 900_000, 1, {
          productId: 200,
          isFreeReward: true,
          rewardPromotionId: 11,
        }),
      ],
      options: { now },
    });

    expect(result.applied).toHaveLength(1);
    expect(result.totalFreeItemValue).toBe(900_000);
  });

  it('drops the reward when the trigger item is removed', () => {
    const result = coordinatePromotions({
      promotions: [promo],
      lines: [
        line('shirt', 900_000, 1, {
          productId: 200,
          isFreeReward: true,
          rewardPromotionId: 11,
        }),
      ],
      options: { now },
    });

    expect(result.applied).toHaveLength(0);
    expect(result.totalFreeItemValue).toBe(0);
    expect(result.notices.join(' ')).toContain('محرک');
  });
});

describe('out of stock reward', () => {
  const promo = makePromotion({
    id: 21,
    type: PromotionType.BUY_TRIGGER_GET_REWARD,
    rewardType: PromotionRewardType.FREE_ITEM,
    rewardValue: null,
    minQuantity: 1,
    suggestedProductId: 200,
    rewardQuantity: 1,
    autoAddReward: true,
    requiresCustomerAcceptance: false,
  });

  it('does not grant a reward that has no stock', () => {
    const result = coordinatePromotions({
      promotions: [promo],
      lines: [line('suit', 5_000_000, 1, { productId: 100 })],
      options: {
        now,
        isRewardOutOfStock: (productId: number) => productId === 200,
      },
    });

    expect(result.applied).toHaveLength(0);
    expect(result.rejected[0].reasons.join(' ')).toContain('موجود نیست');
  });

  it('does not grant more reward units than available stock', () => {
    const result = coordinatePromotions({
      promotions: [promo],
      lines: [line('suit', 5_000_000, 1, { productId: 100 })],
      options: {
        now,
        variantStock: () => 0,
      },
    });

    expect(result.applied).toHaveLength(0);
  });
});

describe('reward must be accepted before it becomes free', () => {
  const promo = makePromotion({
    id: 31,
    type: PromotionType.BUY_TRIGGER_GET_REWARD,
    rewardType: PromotionRewardType.FREE_ITEM,
    rewardValue: null,
    minQuantity: 1,
    suggestedProductId: 200,
    autoAddReward: false,
    requiresCustomerAcceptance: true,
  });

  it('flags the promotion as requiring action but not free until accepted', () => {
    const pending = coordinatePromotions({
      promotions: [promo],
      lines: [line('suit', 5_000_000, 1, { productId: 100 })],
      options: { now },
    });

    expect(pending.applied[0].requiresAction).toBe(true);
    expect(pending.totalFreeItemValue).toBe(0);

    const accepted = coordinatePromotions({
      promotions: [promo],
      lines: [
        line('suit', 5_000_000, 1, { productId: 100 }),
        line('shirt', 700_000, 1, {
          productId: 200,
          isFreeReward: true,
          rewardPromotionId: 31,
        }),
      ],
      options: { now, acceptedRewards: { 31: true } },
    });

    expect(accepted.totalFreeItemValue).toBe(700_000);
  });
});

describe('usage limits', () => {
  const promo = makePromotion({ id: 41, maxTotalUses: 2, maxUsesPerCustomer: 1 });

  it('honours total and per-customer limits', () => {
    const totalLimit = coordinatePromotions({
      promotions: [promo],
      lines: [line('a', 1_000_000, 2)],
      options: { now, usageByPromotion: { 41: { total: 2, perCustomer: 0 } } },
    });
    expect(totalLimit.applied).toHaveLength(0);

    const perCustomer = coordinatePromotions({
      promotions: [promo],
      lines: [line('a', 1_000_000, 2)],
      options: {
        now,
        usageByPromotion: { 41: { total: 0, perCustomer: 1 } },
      },
    });
    expect(perCustomer.applied).toHaveLength(0);
    expect(perCustomer.rejected[0].reasons.join(' ')).toContain(
      'استفاده کرده‌اید',
    );
  });
});

describe('double discount prevention', () => {
  it('caps the sum of stacked discounts at the line value', () => {
    const first = makePromotion({ id: 51, canStack: true, rewardValue: 90 });
    const second = makePromotion({
      id: 52,
      canStack: true,
      type: PromotionType.SPEND_AND_SAVE,
      rewardType: PromotionRewardType.PERCENTAGE,
      rewardValue: 60,
      minCartValue: 100,
    });

    const result = coordinatePromotions({
      promotions: [first, second],
      lines: [line('a', 1_000_000, 2)],
      options: { now },
    });

    const appliedTotal = result.applied.reduce((sum, item) => {
      return (
        sum +
        item.allocations
          .filter(allocation => !allocation.isFree)
          .reduce((lineSum, allocation) => lineSum + allocation.amount, 0)
      );
    }, 0);

    expect(appliedTotal).toBeLessThanOrEqual(2_000_000);
    expect(result.totalDiscount).toBe(2_000_000);
  });
});

describe('free units consume the line budget when stacking', () => {
  it('never discounts more than the line is worth across two promotions', () => {
    /*
     * سناریوی واقعی: «خرید ۲، ۱ رایگان» + «۱۰٪ تخفیف سبد» هر دو قابل ترکیب.
     * اگر واحد رایگان از بودجهٔ ردیف کم نکند، پروموشن دوم همان واحد را دوباره
     * تخفیف می‌دهد و جمع تخفیف از ارزش ردیف بیشتر می‌شود.
     */
    const freeItemPromo = makePromotion({
      id: 91,
      type: PromotionType.BUY_X_GET_Y_SAME_GROUP,
      rewardType: PromotionRewardType.FREE_ITEM,
      rewardValue: null,
      requiredQuantity: 1,
      freeQuantity: 1,
      canStack: true,
      scope: PromotionScope.ALL,
    });

    // ۱۰۰٪ تخفیف سبد: بدون بودجه‌گذاری صحیح، این با «۱ رایگان» جمع می‌شود و
    // از ارزش سبد رد می‌شود.
    const cartDiscount = makePromotion({
      id: 92,
      type: PromotionType.CART_DISCOUNT,
      rewardType: PromotionRewardType.PERCENTAGE,
      rewardValue: 100,
      canStack: true,
    });

    const lines = [line('shirt', 1_000_000, 2)];
    const cartValue = 2_000_000;

    const result = coordinatePromotions({
      promotions: [freeItemPromo, cartDiscount],
      lines,
      options: { now, allowStacking: true },
    });

    const totalDiscount = result.applied.reduce(
      (sum, evaluation) =>
        sum +
        evaluation.allocations
          .filter(allocation => !allocation.isFree)
          .reduce((lineSum, allocation) => lineSum + allocation.amount, 0),
      0,
    );

    const totalFree = result.applied.reduce(
      (sum, evaluation) =>
        sum +
        evaluation.allocations
          .filter(allocation => allocation.isFree)
          .reduce((lineSum, allocation) => lineSum + allocation.amount, 0),
      0,
    );

    // هیچ‌وقت بیشتر از ارزش سبد تخفیف + رایگان نمی‌شود
    expect(totalDiscount + totalFree).toBeLessThanOrEqual(cartValue);
  });
});

describe('pre-cart suggestions', () => {
  const promo = makePromotion({
    id: 61,
    type: PromotionType.BUY_TRIGGER_GET_REWARD,
    rewardType: PromotionRewardType.FREE_ITEM,
    rewardValue: null,
    minQuantity: 1,
    suggestedProductId: 200,
    showPreCartPopup: true,
    popupTitle: 'یک پیراهن هدیه بگیرید',
    requiresCustomerAcceptance: true,
    autoAddReward: false,
  });

  it('suggests a reward when the cart contains a trigger', () => {
    const result = coordinatePromotions({
      promotions: [promo],
      lines: [line('suit', 5_000_000, 1, { productId: 100 })],
      options: { now },
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].promotionId).toBe(61);
    expect(result.suggestions[0].rewardIsFree).toBe(true);
    expect(result.suggestions[0].suggestedProduct?.productId).toBe(200);
  });

  it('does not suggest anything for an empty cart', () => {
    const result = coordinatePromotions({
      promotions: [promo],
      lines: [],
      options: { now },
    });

    expect(result.suggestions).toHaveLength(0);
  });
});

describe('pre-cart suggestion actions', () => {
  it('adds the free reward when the trigger condition is already met', () => {
    const promo = makePromotion({
      id: 71,
      type: PromotionType.BUY_TRIGGER_GET_REWARD,
      rewardType: PromotionRewardType.FREE_ITEM,
      rewardValue: null,
      minQuantity: 1,
      suggestedProductId: 200,
      showPreCartPopup: true,
    });

    const result = coordinatePromotions({
      promotions: [promo],
      lines: [line('suit', 5_000_000, 1, { productId: 100 })],
      options: { now },
    });

    expect(result.suggestions[0].action).toBe('add_free_reward');
  });

  it('marks a missing trigger as a paid item, never a free reward', () => {
    const promo = makePromotion({
      id: 72,
      type: PromotionType.BUY_TRIGGER_GET_REWARD,
      rewardType: PromotionRewardType.FREE_ITEM,
      rewardValue: null,
      minQuantity: 3,
      suggestedProductId: 100,
      showPreCartPopup: true,
    });

    const result = coordinatePromotions({
      promotions: [promo],
      lines: [line('suit', 5_000_000, 1, { productId: 100 })],
      options: { now },
    });

    expect(result.suggestions[0].action).toBe('add_paid_item');
  });

  it('completing a buy-X-get-Y condition is a paid item', () => {
    const promo = makePromotion({
      id: 73,
      type: PromotionType.BUY_X_GET_Y_SAME_GROUP,
      rewardType: PromotionRewardType.FREE_ITEM,
      rewardValue: null,
      requiredQuantity: 2,
      freeQuantity: 1,
      showPreCartPopup: true,
      scope: PromotionScope.PRODUCTS,
      products: [{ id: 100, categories: [] } as never],
    });

    const result = coordinatePromotions({
      promotions: [promo],
      lines: [line('shirt', 1_000_000, 1, { productId: 100 })],
      options: { now },
    });

    expect(result.suggestions[0].action).toBe('add_paid_item');
  });

  it('spend-more suggestions only guide the customer to the cart', () => {
    const promo = makePromotion({
      id: 74,
      type: PromotionType.SPEND_AND_SAVE,
      rewardType: PromotionRewardType.PERCENTAGE,
      rewardValue: 10,
      minCartValue: 10_000_000,
      suggestedProductId: 200,
      showPreCartPopup: true,
    });

    const result = coordinatePromotions({
      promotions: [promo],
      lines: [line('suit', 5_000_000, 1)],
      options: { now },
    });

    expect(result.suggestions[0].action).toBe('open_cart');
  });

  it('every suggestion declares an action', () => {
    const promotions = [
      makePromotion({
        id: 81,
        type: PromotionType.BUY_TRIGGER_GET_REWARD,
        rewardType: PromotionRewardType.FREE_ITEM,
        minQuantity: 1,
        suggestedProductId: 200,
        showPreCartPopup: true,
      }),
      makePromotion({
        id: 82,
        type: PromotionType.SPEND_AND_SAVE,
        minCartValue: 99_000_000,
        suggestedProductId: 200,
        showPreCartPopup: true,
      }),
    ];

    const result = coordinatePromotions({
      promotions,
      lines: [line('suit', 5_000_000, 1, { productId: 100 })],
      options: { now },
    });

    expect(result.suggestions.length).toBeGreaterThan(0);

    for (const suggestion of result.suggestions) {
      expect(['add_free_reward', 'add_paid_item', 'open_cart']).toContain(
        suggestion.action,
      );
    }
  });
});
