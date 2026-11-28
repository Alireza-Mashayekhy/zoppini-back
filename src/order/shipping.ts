import { ShippingMethod } from './dto/create-order.dto';

/** Prepaid postal shipping, in the same unit as order prices (toman). */
export const POST_SHIPPING_COST_TOMAN = 250_000;

/** Prepaid Tipax shipping (toman). Was postpaid (paid on delivery) before. */
export const TIPAX_SHIPPING_COST_TOMAN = 250_000;

/**
 * Fixed, prepaid shipping charges per method (toman).
 *
 * Methods that are absent are free (pickup) or postpaid — paid to the carrier
 * on delivery (courier) — and therefore add nothing to the order total.
 *
 * Any method listed here is charged at checkout; the charge is frozen on the
 * order (`order.shippingCost`), paid through the gateway/wallet with the rest of
 * the order and posted to Rahkaran as the shipping service product, whose price
 * list amount (rial) must equal this value × 10.
 */
export const FIXED_SHIPPING_COST_TOMAN: Readonly<
  Partial<Record<ShippingMethod, number>>
> = Object.freeze({
  [ShippingMethod.POST]: POST_SHIPPING_COST_TOMAN,
  [ShippingMethod.TIBAX]: TIPAX_SHIPPING_COST_TOMAN,
});

/** Prepaid shipping charge for a method (toman); 0 for free/postpaid/none. */
export function getShippingCostToman(shippingMethod?: ShippingMethod): number {
  if (!shippingMethod) return 0;
  return FIXED_SHIPPING_COST_TOMAN[shippingMethod] ?? 0;
}
