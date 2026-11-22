import { Cart } from 'src/cart/entities/cart.entity';
import { CartItem } from 'src/cart/entities/cart-item.entity';

export interface SalePricedCartLineInput {
  item: CartItem;
  /** قیمت فهرست هر واحد (قبل از تخفیف سطح محصول) */
  originalPrice: number;
  /** قیمت هر واحد پس از تخفیف سطح محصول */
  unitPrice: number;
}

/**
 * کلون سبد برای ارزیابی پروموشن‌ها — «یک منبع حقیقت» برای سبد، چک‌اوت
 * (پیش‌نمایش) و ثبت سفارش.
 *
 * موتور پروموشن باید روی قیمت‌های «پس از تخفیف سطح محصول» کار کند، چون
 * مبنای محاسبهٔ تخفیف سبد هم همین قیمت است؛ اما قیمت فهرست هم باید برای
 * مبنای «قیمت اصلی» (original_price) و تشخیص محصولات دارای تخفیف در دسترس
 * باشد:
 *
 * - `variant.price`     → قیمت پس از تخفیف سطح محصول
 * - `variant.listPrice` → قیمت فهرست (قبل از تخفیف سطح محصول)
 *
 * ردیف‌های هدیه (promotionRewardId) تغییری نمی‌کنند؛ فقط قیمت فهرست آن‌ها
 * هم تعریف می‌شود تا محاسبات ردیفشان سازگار باشد.
 */
export function buildPricedPromotionCart(
  cart: Cart,
  salePricedLines: SalePricedCartLineInput[],
): Cart {
  const clones = salePricedLines.map(line => {
    const clone = Object.create(Object.getPrototypeOf(line.item)) as CartItem;

    Object.assign(clone, line.item, {
      variant: {
        ...line.item.variant,
        price: line.unitPrice,
        listPrice: line.originalPrice,
      },
    });

    return clone;
  });

  return Object.assign(Object.create(Object.getPrototypeOf(cart)), cart, {
    items: clones,
  }) as Cart;
}
