import { calculateFirstPurchaseGiftDiscount } from './first-purchase-gift-pricing';

describe('calculateFirstPurchaseGiftDiscount', () => {
  it('calculates the configured percentage on eligible product subtotal only', () => {
    expect(calculateFirstPurchaseGiftDiscount(12_000, 15)).toBe(1_800);
  });

  it('caps the amount at the eligible subtotal and rounds to a whole toman', () => {
    expect(calculateFirstPurchaseGiftDiscount(99, 100)).toBe(99);
    expect(calculateFirstPurchaseGiftDiscount(101, 15)).toBe(15);
  });

  it('returns zero for empty or invalid subtotal input', () => {
    expect(calculateFirstPurchaseGiftDiscount(0, 15)).toBe(0);
    expect(calculateFirstPurchaseGiftDiscount(-100, 15)).toBe(0);
    expect(calculateFirstPurchaseGiftDiscount(Number.NaN, 15)).toBe(0);
  });
});
