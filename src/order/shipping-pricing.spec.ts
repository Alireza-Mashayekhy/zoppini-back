import { calculateCheckoutTotals } from './checkout-pricing';
import { ShippingMethod } from './dto/create-order.dto';
import {
  FIXED_SHIPPING_COST_TOMAN,
  getShippingCostToman,
  POST_SHIPPING_COST_TOMAN,
  TIPAX_SHIPPING_COST_TOMAN,
} from './shipping';

describe('shipping method charges', () => {
  it('charges Tipax a fixed 250,000 toman instead of postpaid', () => {
    expect(TIPAX_SHIPPING_COST_TOMAN).toBe(250_000);
    expect(getShippingCostToman(ShippingMethod.TIBAX)).toBe(250_000);
  });

  it('keeps every other method unchanged', () => {
    expect(getShippingCostToman(ShippingMethod.POST)).toBe(250_000);
    // پیک پس‌کرایه می‌ماند و حضوری رایگان
    expect(getShippingCostToman(ShippingMethod.COURIER)).toBe(0);
    expect(getShippingCostToman(ShippingMethod.PICKUP)).toBe(0);
    expect(getShippingCostToman(undefined)).toBe(0);
    expect(getShippingCostToman('legacy' as ShippingMethod)).toBe(0);
    expect(Object.keys(FIXED_SHIPPING_COST_TOMAN).sort()).toEqual([
      'post',
      'tibax',
    ]);
  });

  it('matches the Rahkaran shipping product price (rial = toman × 10)', () => {
    for (const cost of Object.values(FIXED_SHIPPING_COST_TOMAN)) {
      expect(cost * 10).toBe(2_500_000);
    }
  });
});

describe('postal shipping totals', () => {
  const lines = [
    {
      lineId: 1,
      variantId: 1,
      productId: 1,
      quantity: 1,
      originalPrice: 1_000_000,
      salePrice: 1_000_000,
    },
    {
      lineId: 2,
      variantId: 2,
      productId: 2,
      quantity: 2,
      originalPrice: 500_000,
      salePrice: 500_000,
    },
  ];

  it('adds the Tipax charge exactly once, like the postal one', () => {
    const totals = calculateCheckoutTotals({
      lines,
      shippingCost: getShippingCostToman(ShippingMethod.TIBAX),
    });
    expect(totals.shippingCost).toBe(250_000);
    expect(totals.finalPrice).toBe(2_250_000);
    expect(totals.consistency.ok).toBe(true);
  });

  it('adds shipping exactly once for a two-million-toman cart', () => {
    const totals = calculateCheckoutTotals({
      lines,
      shippingCost: POST_SHIPPING_COST_TOMAN,
    });
    expect(totals.originalPrice).toBe(2_000_000);
    expect(totals.shippingCost).toBe(250_000);
    expect(totals.finalPrice).toBe(2_250_000);
  });

  it('keeps the charge independent of coupon, quantity changes and free-shipping promotions', () => {
    const totals = calculateCheckoutTotals({
      lines,
      shippingCost: POST_SHIPPING_COST_TOMAN,
      codeDiscount: 200_000,
    });
    expect(totals.finalPrice).toBe(2_050_000);
    const changed = calculateCheckoutTotals({
      lines: [{ ...lines[0], quantity: 2 }],
      shippingCost: POST_SHIPPING_COST_TOMAN,
    });
    expect(changed.finalPrice).toBe(2_250_000);
    const free = calculateCheckoutTotals({
      lines,
      shippingCost: POST_SHIPPING_COST_TOMAN,
      freeShipping: true,
    });
    expect(free.shippingCost).toBe(0);
    expect(free.finalPrice).toBe(2_000_000);
  });
});
