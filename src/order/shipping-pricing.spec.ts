import { calculateCheckoutTotals } from './checkout-pricing';
import { POST_SHIPPING_COST_TOMAN } from './shipping';

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
