import { Promotion } from './entities/promotion.entity';
import {
  FreeItemSelection,
  PromotionRewardType,
  PromotionScope,
  PromotionType,
} from './entities/promotion.entity';
import { PromotionsService } from './promotions.service';

/**
 * نشان‌های پروموشن صفحهٔ محصول.
 *
 * قرارداد: علاوه بر متن نشان، «نام» و «مقدار پاداش» واقعی پروموشن هم در همان
 * پاسخ برمی‌گردد تا بنر صفحهٔ محصول درصد را از دادهٔ واقعی بخواند (بدون
 * هاردکد در فرانت). این تست فقط قرارداد داده را قفل می‌کند و هیچ عدد یا
 * قاعدهٔ صلاحیتی را تغییر نمی‌دهد.
 */

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 1,
    name: 'بلک فرایدی ۱۴۰۴',
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
    showBadgeOnProductPage: true,
    showPreCartPopup: false,
    popupTitle: null,
    popupDescription: null,
    popupAcceptLabel: null,
    popupDismissLabel: null,
    popupSuggestedProductId: null,
    applyToDiscountedProducts: false,
    cartDiscountBase: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  } as Promotion;
}

const EMPTY_SCOPE = {
  products: new Set<number>(),
  categories: new Set<number>(),
  excludedProducts: new Set<number>(),
  excludedCategories: new Set<number>(),
  rewardProducts: new Set<number>(),
  rewardCategories: new Set<number>(),
};

function makeService(promotions: Promotion[]) {
  const service = Object.create(PromotionsService.prototype) as PromotionsService & {
    promotionsRepository: unknown;
    logger: unknown;
  };

  Object.assign(service, {
    promotionsRepository: {
      getActivePrepared: async () =>
        promotions.map(promotion => ({ promotion, scope: EMPTY_SCOPE })),
    },
    logger: {
      warn: () => {},
      log: () => {},
      error: () => {},
      debug: () => {},
    },
  });

  return service;
}

function makeProduct(discountAmount = 0) {
  return {
    id: 501,
    categories: [{ id: 9 }],
    variants: [
      {
        price: 2_500_000,
        stock: 4,
        discountAmount,
      },
    ],
  } as never;
}

describe('getProductBadges — payload used by the product page banner', () => {
  it('exposes the real promotion percentage and name for a qualifying product', async () => {
    const service = makeService([makePromotion()]);

    const badges = await service.getProductBadges(makeProduct());

    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({
      promotionId: 1,
      name: 'بلک فرایدی ۱۴۰۴',
      type: PromotionType.CART_DISCOUNT,
      rewardType: PromotionRewardType.PERCENTAGE,
      rewardValue: 20,
    });
    // متن نشان موجود تغییر نکرده است
    expect(badges[0].badgeText).toBeTruthy();
    expect(typeof badges[0].hint).toBe('string');
  });

  it('keeps the badge hidden when the admin disabled it on the product page', async () => {
    const service = makeService([
      makePromotion({ showBadgeOnProductCard: false, showBadgeOnProductPage: false }),
    ]);

    await expect(service.getProductBadges(makeProduct())).resolves.toEqual([]);
  });

  it('keeps the eligibility rule for products that already carry a discount', async () => {
    const service = makeService([makePromotion({ applyToDiscountedProducts: false })]);

    await expect(service.getProductBadges(makeProduct(300_000))).resolves.toEqual([]);
  });

  it('does not invent a percentage for non-percentage rewards', async () => {
    const service = makeService([
      makePromotion({
        type: PromotionType.SPEND_AND_SAVE,
        rewardType: PromotionRewardType.FIXED,
        rewardValue: 500_000,
      }),
    ]);

    const badges = await service.getProductBadges(makeProduct());

    expect(badges).toHaveLength(1);
    expect(badges[0].rewardType).toBe(PromotionRewardType.FIXED);
    expect(badges[0].rewardValue).toBe(500_000);
  });
});
