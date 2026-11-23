import { Logger } from '@nestjs/common';
import { DiscountService } from 'src/discounts/discounts.service';
import { calculateCheckoutTotals } from 'src/order/checkout-pricing';
import {
  CartDiscountBase,
  FreeItemSelection,
  Promotion,
  PromotionRewardType,
  PromotionScope,
  PromotionType,
} from 'src/promotions/entities/promotion.entity';
import { PromotionsService } from 'src/promotions/promotions.service';

import { CartsService } from './cart.service';
import { Cart } from './entities/cart.entity';

/**
 * تست بازتولید و قفل‌کردن «مبنای محاسبهٔ تخفیف عمومی سبد» در مسیر واقعیِ
 * سبد → ارزیابی پروموشن → جمع‌های چک‌اوت.
 *
 * مسیر تست‌شده همان چیزی است که در production اجرا می‌شود:
 * `CartsService.applyPromotionsToCart` (کلونِ قیمت‌گذاری‌شدهٔ سبد) →
 * `PromotionsService.evaluateCart` → موتور پروموشن → `calculateCheckoutTotals`.
 * هیچ‌کدام از این لایه‌ها mock نشده‌اند؛ فقط دیتابیس (پروموشن‌های فعال و
 * فروش‌های ویژه) با مقادیر ثابت جایگزین شده است.
 */

const CATEGORY_BLACK_FRIDAY = 137;
const CATEGORY_OTHER = 210;

const P1_ORIGINAL = 9_980_000;
const P1_DISCOUNT = 4_990_000; // ۵۰٪
const P1_SALE = P1_ORIGINAL - P1_DISCOUNT;

const P2_ORIGINAL = 9_880_000;
const P2_DISCOUNT = 1_976_000; // ۲۰٪
const P2_SALE = P2_ORIGINAL - P2_DISCOUNT;

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
    applyToDiscountedProducts: true,
    cartDiscountBase: CartDiscountBase.DISCOUNTED_PRICE,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * پروموشن با دامنهٔ «دسته‌بندی‌ها» و همان دستهٔ کمپین.
 * `scope` باید CATEGORIES باشد وگرنه موتور همهٔ کالاها را مشمول می‌داند.
 */
function scopedToBlackFriday() {
  return {
    scope: PromotionScope.CATEGORIES,
    categories: [{ id: CATEGORY_BLACK_FRIDAY }] as never,
  };
}

type ItemSpec = {
  lineId: number;
  productId: number;
  categoryIds: number[];
  originalPrice: number;
  salePrice: number;
  quantity?: number;
};

function cartItem(spec: ItemSpec) {
  return {
    id: spec.lineId,
    quantity: spec.quantity ?? 1,
    promotionRewardId: null,
    variant: {
      id: spec.productId + 1,
      price: String(spec.originalPrice),
      stock: 10,
      color: { id: 1, name: 'مشکی' },
      size: { id: 1, name: 'M' },
      product: {
        id: spec.productId,
        title: `محصول ${spec.productId}`,
        slug: `product-${spec.productId}`,
        image: '/test.webp',
        categories: spec.categoryIds.map(id => ({ id, name: `دسته ${id}` })),
      },
    },
  };
}

/**
 * ساخت CartsService با سرویس‌های واقعی و فقط دیتابیسِ جایگزین‌شده.
 * (`applyPromotionsToCart` تنها از `discountService` و `promotionsService`
 * استفاده می‌کند.)
 */
function makeCartsService(options: {
  items: ItemSpec[];
  promotion: Promotion;
  scopeCategoryIds: number[];
}) {
  const saleByProduct = new Map(
    options.items.map(item => [item.productId, item]),
  );

  const discountService = {
    getBestDiscountForProduct: jest.fn(
      (productId: number, _categoryIds: number[], price: number) => {
        const spec = saleByProduct.get(productId);

        if (!spec || spec.salePrice >= price) {
          return null;
        }

        return {
          discount: {
            id: 900 + productId,
            code: null,
            title: 'فروش ویژه',
            type: 'percentage',
            value: 50,
            maxDiscountAmount: null,
          },
          discountAmount: price - spec.salePrice,
          finalPrice: spec.salePrice,
          effectivePercent: Math.round(
            ((price - spec.salePrice) / price) * 100,
          ),
          stages: [],
          stacked: false,
        };
      },
    ),
  } as unknown as DiscountService;

  const promotionsRepository = {
    getActivePrepared: () => [
      {
        promotion: options.promotion,
        scope: {
          products: new Set<number>(),
          categories: new Set<number>(options.scopeCategoryIds),
          excludedProducts: new Set<number>(),
          excludedCategories: new Set<number>(),
          rewardProducts: new Set<number>(),
          rewardCategories: new Set<number>(),
        },
      },
    ],
  };

  const promotionsService = Object.create(
    PromotionsService.prototype,
  ) as PromotionsService;
  Object.assign(promotionsService as object, {
    promotionsRepository,
    logger: new Logger('PromotionsService'),
  });
  jest
    .spyOn(promotionsService as never, 'loadUsage' as never)
    .mockResolvedValue({} as never);

  const cartsService = Object.create(CartsService.prototype) as CartsService;
  Object.assign(cartsService as object, {
    discountService,
    promotionsService,
    logger: new Logger('CartsService'),
  });

  const cart = {
    id: 1,
    userId: 1,
    items: options.items.map(cartItem),
    dismissedPromotions: [],
    acceptedPromotions: [],
    selectedRewards: [],
    promotionPopupShownFor: null,
  } as unknown as Cart;

  return {
    cartsService,
    cart,
    price: () =>
      (
        cartsService as unknown as {
          applyPromotionsToCart: (cart: Cart, userId?: number) => Promise<Cart>;
        }
      ).applyPromotionsToCart(cart, 1),
  };
}

function pricingOf(cart: Cart) {
  return (
    cart as unknown as {
      pricing: {
        originalPrice: number;
        discountPrice: number;
        promotionDiscountPrice: number;
        finalPrice: number;
      };
    }
  ).pricing;
}

function checkoutTotals(cart: Cart) {
  const items = (cart.items ?? []) as unknown as {
    id: number;
    quantity: number;
    payableTotal: number;
    variant: { id: number; originalPrice: number };
    promotion: { promotionDiscount: number; promotionIds: number[] };
    promotionRewardId?: number | null;
  }[];

  return calculateCheckoutTotals({
    lines: items.map(item => {
      const promotionDiscount = Number(item.promotion?.promotionDiscount ?? 0);
      const quantity = Math.max(1, Number(item.quantity));
      /*
       * قیمت فروش هر واحد = (جمع ردیف + سهم پروموشن) ÷ تعداد.
       * همان تفکیکی که در سفارش ذخیره می‌شود: قیمت فروش ویژه جدا از تخفیف
       * سبد، تا «جمع ردیف‌ها» با «جمع کل» یکی بماند.
       */
      const salePrice =
        (Number(item.payableTotal) + promotionDiscount) / quantity;

      return {
        lineId: item.id,
        variantId: item.variant.id,
        productId: item.id,
        quantity,
        originalPrice: Number(item.variant.originalPrice),
        salePrice,
        promotionDiscount,
        promotionIds: item.promotion?.promotionIds ?? [],
      };
    }),
    shippingCost: 0,
  });
}

describe('cart promotion calculation base (sequential vs additive)', () => {
  // ---------------------------------------------
  // Test A — sequential (discounted product price)
  // ---------------------------------------------
  it('A: 20% cart discount is calculated on the already discounted price', async () => {
    const { price } = makeCartsService({
      items: [
        {
          lineId: 1,
          productId: 1001,
          categoryIds: [CATEGORY_BLACK_FRIDAY],
          originalPrice: P1_ORIGINAL,
          salePrice: P1_SALE,
        },
      ],
      promotion: makePromotion({
        ...scopedToBlackFriday(),
        applyToDiscountedProducts: true,
        cartDiscountBase: CartDiscountBase.DISCOUNTED_PRICE,
      }),
      scopeCategoryIds: [CATEGORY_BLACK_FRIDAY],
    });

    const cart = await price();
    const pricing = pricingOf(cart);

    expect(pricing.originalPrice).toBe(P1_ORIGINAL);
    expect(pricing.discountPrice).toBe(P1_DISCOUNT);
    expect(pricing.promotionDiscountPrice).toBe(998_000);
    expect(pricing.finalPrice).toBe(3_992_000);
  });

  // ---------------------------------------------
  // Test B — additive (original product price)
  // ---------------------------------------------
  it('B: original-price mode keeps the additive behaviour', async () => {
    const { price } = makeCartsService({
      items: [
        {
          lineId: 1,
          productId: 1001,
          categoryIds: [CATEGORY_BLACK_FRIDAY],
          originalPrice: 10_000_000,
          salePrice: 5_000_000,
        },
      ],
      promotion: makePromotion({
        ...scopedToBlackFriday(),
        applyToDiscountedProducts: true,
        cartDiscountBase: CartDiscountBase.ORIGINAL_PRICE,
      }),
      scopeCategoryIds: [CATEGORY_BLACK_FRIDAY],
    });

    const cart = await price();
    const pricing = pricingOf(cart);

    expect(pricing.discountPrice).toBe(5_000_000);
    expect(pricing.promotionDiscountPrice).toBe(2_000_000);
    expect(pricing.finalPrice).toBe(3_000_000);
  });

  // ---------------------------------------------
  // Test C — product without product-level discount
  // ---------------------------------------------
  it('C: product without its own discount pays list price × (1 − 20%)', async () => {
    const { price } = makeCartsService({
      items: [
        {
          lineId: 1,
          productId: 1001,
          categoryIds: [CATEGORY_BLACK_FRIDAY],
          originalPrice: 10_000_000,
          salePrice: 10_000_000,
        },
      ],
      promotion: makePromotion({
        ...scopedToBlackFriday(),
        applyToDiscountedProducts: true,
        cartDiscountBase: CartDiscountBase.DISCOUNTED_PRICE,
      }),
      scopeCategoryIds: [CATEGORY_BLACK_FRIDAY],
    });

    const cart = await price();
    const pricing = pricingOf(cart);

    expect(pricing.discountPrice).toBe(0);
    expect(pricing.promotionDiscountPrice).toBe(2_000_000);
    expect(pricing.finalPrice).toBe(8_000_000);
  });

  // ---------------------------------------------
  // Test D — existing eligibility stays untouched
  // ---------------------------------------------
  it('D: only products inside the promotion scope receive the cart discount', async () => {
    const { price } = makeCartsService({
      items: [
        {
          lineId: 1,
          productId: 1001,
          categoryIds: [CATEGORY_BLACK_FRIDAY],
          originalPrice: P1_ORIGINAL,
          salePrice: P1_SALE,
        },
        {
          lineId: 2,
          productId: 1002,
          categoryIds: [CATEGORY_OTHER],
          originalPrice: P2_ORIGINAL,
          salePrice: P2_SALE,
        },
      ],
      promotion: makePromotion({
        ...scopedToBlackFriday(),
        applyToDiscountedProducts: true,
        cartDiscountBase: CartDiscountBase.DISCOUNTED_PRICE,
      }),
      scopeCategoryIds: [CATEGORY_BLACK_FRIDAY],
    });

    const cart = await price();
    const pricing = pricingOf(cart);

    // محصول خارج از دامنه دست‌نخورده می‌ماند
    expect(pricing.discountPrice).toBe(P1_DISCOUNT + P2_DISCOUNT);
    expect(pricing.promotionDiscountPrice).toBe(998_000);
    expect(pricing.finalPrice).toBe(3_992_000 + P2_SALE);
    expect(pricing.finalPrice).toBe(11_896_000);

    const items = (cart.items ?? []) as unknown as {
      id: number;
      payablePrice: number;
    }[];

    expect(items.find(item => item.id === 1)?.payablePrice).toBe(3_992_000);
    expect(items.find(item => item.id === 2)?.payablePrice).toBe(P2_SALE);
  });

  it('D2: with the eligibility switch off, discounted products stay excluded', async () => {
    const { price } = makeCartsService({
      items: [
        {
          lineId: 1,
          productId: 1001,
          categoryIds: [CATEGORY_BLACK_FRIDAY],
          originalPrice: P1_ORIGINAL,
          salePrice: P1_SALE,
        },
        {
          lineId: 2,
          productId: 1002,
          categoryIds: [CATEGORY_BLACK_FRIDAY],
          originalPrice: 1_000_000,
          salePrice: 1_000_000,
        },
      ],
      promotion: makePromotion({
        ...scopedToBlackFriday(),
        applyToDiscountedProducts: false,
      }),
      scopeCategoryIds: [CATEGORY_BLACK_FRIDAY],
    });

    const cart = await price();
    const pricing = pricingOf(cart);

    // فقط ردیف بدون تخفیف مشمول می‌شود: ۲۰٪ از ۱٬۰۰۰٬۰۰۰
    expect(pricing.promotionDiscountPrice).toBe(200_000);
    expect(pricing.finalPrice).toBe(P1_SALE + 800_000);
  });

  // ---------------------------------------------
  // Test E — repeated recalculation is idempotent
  // ---------------------------------------------
  it('E: recalculating the same cart never accumulates the promotion', async () => {
    const { price } = makeCartsService({
      items: [
        {
          lineId: 1,
          productId: 1001,
          categoryIds: [CATEGORY_BLACK_FRIDAY],
          originalPrice: P1_ORIGINAL,
          salePrice: P1_SALE,
        },
        {
          lineId: 2,
          productId: 1002,
          categoryIds: [CATEGORY_OTHER],
          originalPrice: P2_ORIGINAL,
          salePrice: P2_SALE,
        },
      ],
      promotion: makePromotion({
        ...scopedToBlackFriday(),
        applyToDiscountedProducts: true,
        cartDiscountBase: CartDiscountBase.DISCOUNTED_PRICE,
      }),
      scopeCategoryIds: [CATEGORY_BLACK_FRIDAY],
    });

    const first = pricingOf(await price());
    const second = pricingOf(await price());
    const third = pricingOf(await price());

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(third.promotionDiscountPrice).toBe(998_000);
    expect(third.finalPrice).toBe(11_896_000);
  });

  // ---------------------------------------------
  // Test F — cart, checkout and order agree
  // ---------------------------------------------
  it('F: cart lines, cart summary and checkout totals are identical', async () => {
    const { price } = makeCartsService({
      items: [
        {
          lineId: 1,
          productId: 1001,
          categoryIds: [CATEGORY_BLACK_FRIDAY],
          originalPrice: P1_ORIGINAL,
          salePrice: P1_SALE,
        },
        {
          lineId: 2,
          productId: 1002,
          categoryIds: [CATEGORY_OTHER],
          originalPrice: P2_ORIGINAL,
          salePrice: P2_SALE,
        },
      ],
      promotion: makePromotion({
        ...scopedToBlackFriday(),
        applyToDiscountedProducts: true,
        cartDiscountBase: CartDiscountBase.DISCOUNTED_PRICE,
      }),
      scopeCategoryIds: [CATEGORY_BLACK_FRIDAY],
    });

    const cart = await price();
    const pricing = pricingOf(cart);
    const totals = checkoutTotals(cart);

    expect(totals.originalPrice).toBe(19_860_000);
    expect(totals.saleDiscount).toBe(6_966_000);
    expect(totals.promotionDiscount).toBe(998_000);
    expect(totals.finalPrice).toBe(11_896_000);
    expect(totals.finalPrice).toBe(pricing.finalPrice);
    expect(totals.promotionDiscount).toBe(pricing.promotionDiscountPrice);
    expect(totals.consistency.ok).toBe(true);
    expect(totals.lines.reduce((sum, line) => sum + line.payableTotal, 0)).toBe(
      11_896_000,
    );

    // جمع قیمت نهایی ردیف‌های سبد (همان عددی که کارت سبد نشان می‌دهد) باید
    // دقیقاً برابر «جمع کل» باشد؛ تخفیف سبد نباید دو بار حساب شود.
    const lineTotals = (cart.items ?? []) as unknown as {
      payableTotal: number;
      promotion: { promotionDiscount: number };
    }[];

    expect(
      lineTotals.reduce((sum, item) => sum + Number(item.payableTotal), 0),
    ).toBe(pricing.finalPrice);
    expect(
      lineTotals.reduce(
        (sum, item) => sum + Number(item.promotion.promotionDiscount),
        0,
      ),
    ).toBe(pricing.promotionDiscountPrice);
  });
});
