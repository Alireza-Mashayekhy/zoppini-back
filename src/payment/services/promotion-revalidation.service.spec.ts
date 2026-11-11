import { BadRequestException } from '@nestjs/common';
import { OrderItem } from 'src/order/entities/order-item';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { Variant } from 'src/products/entities/variant.entity';

import { PromotionRevalidationService } from './promotion-revalidation.service';

/**
 * این سرویس آخرین سد بین مشتری و درگاه است.
 *
 * قانون طلایی: هرگز مبلغی بیشتر از آنچه مشتری تأیید کرده از او گرفته نشود.
 * اگر پروموشنی منقضی شود، سفارش باید **ارزان‌تر یا برابر** شود، نه گران‌تر؛
 * و اگر تفاوتی هست، مشتری باید صریحاً دوباره تأیید کند.
 */

function makeItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 1,
    quantity: 1,
    price: 1_000_000,
    totalPrice: 1_000_000,
    promotionDiscount: 0,
    isPromotionReward: false,
    promotionRewardId: null,
    promotionLabel: null,
    promotionIds: null,
    variantId: 11,
    order: null as never,
    ...overrides,
  } as unknown as OrderItem;
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 900,
    status: OrderStatus.PENDING,
    totalPrice: 10_000_000,
    saleDiscount: 1_000_000,
    promotionDiscount: 2_000_000,
    promotionFreeItemValue: 0,
    promotionFreeShipping: false,
    discount: 500_000,
    shippingCost: 100_000,
    finalPrice: 6_600_000,
    items: [makeItem()],
    promotionSnapshot: [
      {
        promotionId: 5,
        name: 'کمپین پاییز',
        type: 'cart_discount',
        discountAmount: 2_000_000,
        freeItemValue: 0,
        grantsFreeShipping: false,
        qualifyingVariantIds: [11],
        rewardVariantIds: [],
        rewardProductIds: [],
        lines: [],
      },
    ],
    ...overrides,
  } as unknown as Order;
}

function makeService(options: {
  promotion?: { expiresAt: Date } | null;
  stock?: number;
}) {
  const promotions = {
    findActiveById: jest
      .fn()
      .mockResolvedValue(
        options.promotion === null
          ? null
          : { id: 5, expiresAt: options.promotion?.expiresAt ?? new Date('2030-01-01') },
      ),
  };

  const manager = {
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === Variant) {
        return { id: 11, stock: options.stock ?? 10 };
      }

      return null;
    }),
    save: jest.fn(async (_entity: unknown, value: unknown) => value),
  };

  const dataSource = { manager } as never;

  const service = new PromotionRevalidationService(
    promotions as never,
    dataSource,
  );

  return { service, manager, promotions };
}

describe('promotion revalidation before charging', () => {
  it('leaves a fully valid order untouched', async () => {
    const { service, manager } = makeService({});

    const order = makeOrder();
    const result = await service.revalidateOrder(order);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(order.finalPrice).toBe(6_600_000);
    // هیچ ذخیره‌ای رخ نمی‌دهد
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('never raises the final price when a promotion is removed', async () => {
    const { service } = makeService({ promotion: null });

    const order = makeOrder();
    const result = await service.revalidateOrder(order);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);

    // ۱۰٬۰۰۰٬۰۰۰ − ۱٬۰۰۰٬۰۰۰ (فروش ویژه) − ۰ (پروموشن حذف شد) − ۵۰۰٬۰۰۰ + ۱۰۰٬۰۰۰
    expect(order.finalPrice).toBe(8_600_000);
    expect(Number(order.promotionDiscount)).toBe(0);
  });

  it('keeps sale and code discounts intact while dropping only the promotion', async () => {
    const { service } = makeService({ promotion: null });

    const order = makeOrder({
      saleDiscount: 2_000_000,
      discount: 300_000,
      promotionDiscount: 1_500_000,
      totalPrice: 12_000_000,
      shippingCost: 0,
    });

    await service.revalidateOrder(order);

    // فروش ویژه و کد تخفیف نباید قربانی حذف پروموشن شوند
    expect(Number(order.saleDiscount)).toBe(2_000_000);
    expect(Number(order.discount)).toBe(300_000);
    expect(Number(order.promotionDiscount)).toBe(0);
    expect(order.finalPrice).toBe(12_000_000 - 2_000_000 - 300_000);
  });

  it('removes an invalid free gift line and clears its value from the invoice', async () => {
    const { service } = makeService({ promotion: null });

    /*
     * مطابق createOrder: ارزش هدیه در promotionDiscount ردیف و در
     * order.promotionFreeItemValue ثبت می‌شود.
     */
    const gift = makeItem({
      id: 2,
      variantId: 99,
      price: 0,
      totalPrice: 0,
      isPromotionReward: true,
      promotionRewardId: 5,
      promotionDiscount: 900_000,
      quantity: 1,
    });

    const order = makeOrder({
      items: [makeItem(), gift],
      promotionDiscount: 900_000,
      promotionFreeItemValue: 900_000,
      // ۱۰٬۰۰۰٬۰۰۰ − ۱٬۰۰۰٬۰۰۰ − ۹۰۰٬۰۰۰ − ۵۰۰٬۰۰۰ + ۱۰۰٬۰۰۰ = ۷٬۷۰۰٬۰۰۰
      finalPrice: 7_700_000,
      promotionSnapshot: [
        {
          promotionId: 5,
          name: 'هدیه پیراهن',
          type: 'buy_trigger_get_reward',
          discountAmount: 0,
          freeItemValue: 900_000,
          grantsFreeShipping: false,
          qualifyingVariantIds: [11],
          rewardVariantIds: [99],
          rewardProductIds: [200],
          lines: [],
        },
      ],
    });

    const result = await service.revalidateOrder(order);

    expect(result.ok).toBe(false);
    expect(gift.quantity).toBe(0);
    expect(gift.isPromotionReward).toBe(false);
    expect(Number(gift.promotionDiscount)).toBe(0);
    expect(Number(order.promotionFreeItemValue)).toBe(0);
    expect(Number(order.promotionDiscount)).toBe(0);
    // با رفتن هدیه، تخفیفش هم می‌رود: ۱۰٬۰۰۰٬۰۰۰ − ۱٬۰۰۰٬۰۰۰ − ۵۰۰٬۰۰۰ + ۱۰۰٬۰۰۰
    expect(order.finalPrice).toBe(8_600_000);

    /*
     * اسنپ‌شات هم پاک می‌شود: اگر دوباره بررسی شود، دیگر پروموشن غیرمعتبری
     * برای حذف باقی نمانده است. یعنی پس از یک بار اصلاح، سفارش سازگار است و
     * درخواست دوبارهٔ پرداخت با پیام خطا مواجه نمی‌شود (مشتری باید مبلغ
     * جدید را در UI تأیید کند، نه این‌که در حلقهٔ خطا بیفتد).
     */
    expect(order.promotionSnapshot).toHaveLength(0);
    await expect(service.revalidateOrder(order)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('keeps a valid reward in place even when other conditions are fine', async () => {
    const { service } = makeService({ stock: 5 });

    const gift = makeItem({
      id: 2,
      variantId: 99,
      price: 0,
      totalPrice: 0,
      isPromotionReward: true,
      promotionRewardId: 5,
      promotionDiscount: 900_000,
      quantity: 1,
    });

    const order = makeOrder({
      items: [makeItem(), gift],
      promotionFreeItemValue: 900_000,
      promotionSnapshot: [
        {
          promotionId: 5,
          name: 'هدیه پیراهن',
          type: 'buy_trigger_get_reward',
          discountAmount: 0,
          freeItemValue: 900_000,
          grantsFreeShipping: false,
          qualifyingVariantIds: [11],
          rewardVariantIds: [99],
          rewardProductIds: [200],
          lines: [],
        },
      ],
    });

    const result = await service.revalidateOrder(order);

    expect(result.ok).toBe(true);
    expect(gift.quantity).toBe(1);
  });

  it('reports an out-of-stock reward so the customer is asked to re-confirm', async () => {
    const { service } = makeService({ stock: 0 });

    const gift = makeItem({
      id: 2,
      variantId: 99,
      price: 0,
      totalPrice: 0,
      isPromotionReward: true,
      promotionRewardId: 5,
      promotionDiscount: 900_000,
    });

    const order = makeOrder({
      items: [makeItem(), gift],
      promotionSnapshot: [
        {
          promotionId: 5,
          name: 'هدیه پیراهن',
          type: 'buy_trigger_get_reward',
          discountAmount: 0,
          freeItemValue: 900_000,
          grantsFreeShipping: false,
          qualifyingVariantIds: [11],
          rewardVariantIds: [99],
          rewardProductIds: [200],
          lines: [],
        },
      ],
    });

    const result = await service.revalidateOrder(order);

    expect(result.ok).toBe(false);
    expect(result.changes.join(' ')).toContain('موجودی');
  });

  it('does not reprice an order that is already paid', async () => {
    const { service, manager } = makeService({ promotion: null });

    const order = makeOrder({ status: OrderStatus.PAID });
    const before = order.finalPrice;

    await service.revalidateOrder(order);

    expect(order.finalPrice).toBe(before);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('throws a customer-readable error instead of charging a changed order', async () => {
    const { service } = makeService({ promotion: null });

    await expect(service.assertPayable(makeOrder())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('allows an unchanged order to be charged', async () => {
    const { service } = makeService({});

    await expect(service.assertPayable(makeOrder())).resolves.toMatchObject({
      ok: true,
    });
  });

  it('ignores orders with no promotion snapshot', async () => {
    const { service, promotions } = makeService({});

    const order = makeOrder({ promotionSnapshot: null });

    await expect(service.revalidateOrder(order)).resolves.toMatchObject({
      ok: true,
      changed: false,
    });

    expect(promotions.findActiveById).not.toHaveBeenCalled();
  });
});
