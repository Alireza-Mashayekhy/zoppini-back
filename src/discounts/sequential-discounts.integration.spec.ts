import { calculateCheckoutTotals } from 'src/order/checkout-pricing';

import { DiscountService } from './discounts.service';
import {
  Discount,
  DiscountKind,
  DiscountType,
} from './entities/discount.entity';

/**
 * تست یکپارچگی قیمت در چهار لایه:
 * ۱. قیمت کارت/صفحهٔ محصول (`pickBestSale`)
 * ۲. قیمت سبد (`priceCartLines`)
 * ۳. جمع‌های چک‌اوت (`calculateCheckoutTotals`)
 * ۴. اقلام و جمع سفارش/فاکتور (همان اعدادی که ذخیره می‌شوند)
 *
 * هدف: تخفیف متوالی در هیچ‌کدام از این چهار لایه عدد متفاوتی تولید نکند.
 */

const START = new Date('2025-01-01T00:00:00.000Z');
const END = new Date('2030-01-01T00:00:00.000Z');

function sale(overrides: Partial<Discount>): Discount {
  return {
    id: 1,
    kind: DiscountKind.SALE,
    title: 'مرحله',
    code: null,
    type: DiscountType.PERCENTAGE,
    value: 50,
    maxDiscountAmount: null,
    minOrderAmount: null,
    maxUsesPerUser: null,
    maxTotalUses: null,
    excludeSaleItems: false,
    stackable: true,
    stackPriority: 0,
    appliesToAllProducts: false,
    isActive: true,
    startsAt: START,
    expiresAt: END,
    users: [],
    products: [],
    categories: [],
    excludedProducts: [],
    excludedCategories: [],
    usages: [],
    redemptions: [],
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

function withScope(rows: Discount[]): never {
  return rows.map(row =>
    Object.assign(row, { scopeCategoryIds: new Set<number>() }),
  ) as never;
}

function createService(sales: Discount[]): DiscountService {
  const service = Object.create(DiscountService.prototype) as DiscountService;

  jest.spyOn(service, 'getActiveSales').mockResolvedValue(withScope(sales));

  return service;
}

describe('sequential discounts: product, cart, checkout and invoice agree', () => {
  const first = sale({
    id: 1,
    title: 'تخفیف ۵۰٪',
    value: 50,
    stackable: true,
    stackPriority: 0,
    appliesToAllProducts: true,
  });

  const second = sale({
    id: 2,
    title: 'تخفیف ۲۰٪',
    value: 20,
    stackable: true,
    stackPriority: 1,
    appliesToAllProducts: false,
    products: [{ id: 100 }] as never,
  });

  it('keeps the same final price in product page, cart, checkout and order', async () => {
    const service = createService([first, second]);

    // محصول مشمول هر دو مرحله: 10,000,000 → 4,000,000
    const cardA = service.pickBestSale(
      withScope([first, second]),
      100,
      [],
      10_000_000,
    );

    // محصول فقط مشمول مرحلهٔ اول: 2,000,000 → 1,000,000
    const cardB = service.pickBestSale(
      withScope([first, second]),
      200,
      [],
      2_000_000,
    );

    expect(cardA?.finalPrice).toBe(4_000_000);
    expect(cardB?.finalPrice).toBe(1_000_000);

    const priced = await service.priceCartLines([
      { productId: 100, quantity: 1, price: 10_000_000, categoryIds: [] },
      { productId: 200, quantity: 2, price: 2_000_000, categoryIds: [] },
    ]);

    expect(priced[0].unitPrice).toBe(cardA?.finalPrice);
    expect(priced[1].unitPrice).toBe(cardB?.finalPrice);

    const totals = calculateCheckoutTotals({
      lines: priced.map((line, index) => ({
        lineId: index + 1,
        variantId: index + 1,
        productId: line.productId,
        quantity: line.quantity,
        originalPrice: line.originalPrice,
        salePrice: line.unitPrice,
      })),
      shippingCost: 0,
    });

    // سبد / چک‌اوت
    expect(totals.originalPrice).toBe(14_000_000);
    expect(totals.saleDiscount).toBe(8_000_000);
    expect(totals.finalPrice).toBe(6_000_000);
    expect(totals.consistency.ok).toBe(true);

    // سفارش/فاکتور: همان محاسبه‌ای که order.service انجام می‌دهد
    let totalPrice = 0;
    let saleDiscountAmount = 0;

    const orderItems = priced.map(line => {
      totalPrice += line.originalPrice * line.quantity;
      saleDiscountAmount += line.saleDiscountPerUnit * line.quantity;

      return {
        price: line.unitPrice,
        quantity: line.quantity,
        totalPrice: line.unitPrice * line.quantity,
      };
    });

    const finalPrice = Math.max(0, totalPrice - saleDiscountAmount);

    expect(orderItems).toEqual([
      { price: 4_000_000, quantity: 1, totalPrice: 4_000_000 },
      { price: 1_000_000, quantity: 2, totalPrice: 2_000_000 },
    ]);
    expect(finalPrice).toBe(totals.finalPrice);
  });

  it('legacy sale keeps its single-stage price in every layer', async () => {
    const legacy = sale({
      id: 9,
      value: 30,
      stackable: false,
      appliesToAllProducts: true,
    });

    const service = createService([legacy]);

    const card = service.pickBestSale(withScope([legacy]), 100, [], 1_000_000);

    const [line] = await service.priceCartLines([
      { productId: 100, quantity: 1, price: 1_000_000, categoryIds: [] },
    ]);

    expect(card?.finalPrice).toBe(700_000);
    expect(card?.stacked).toBe(false);
    expect(line.unitPrice).toBe(700_000);
  });
});
