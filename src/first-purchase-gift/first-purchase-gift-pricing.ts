export function calculateFirstPurchaseGiftDiscount(
  eligibleProductSubtotal: number,
  discountPercent: number,
): number {
  const subtotal = Math.max(0, Number(eligibleProductSubtotal) || 0);
  const percent = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  return Math.min(subtotal, Math.round((subtotal * percent) / 100));
}
