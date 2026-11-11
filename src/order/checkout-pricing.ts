import { PromotionEvaluation } from 'src/promotions/engine/promotion-engine';

/**
 * محاسبهٔ قیمت نهایی چک‌اوت — یک منبع واحد حقیقت.
 *
 * سبد، صفحهٔ چک‌اوت، ثبت سفارش و اعتبارسنجی پیش از پرداخت همه از همین
 * تابع استفاده می‌کنند تا اعداد دقیقاً یکی باشند.
 */
export interface CheckoutLineInput {
  /** شناسهٔ ردیف سبد (یا کلید مجازی برای کالای رایگان) */
  lineId: number | string;
  variantId: number | null;
  productId: number;
  quantity: number;
  /** قیمت فهرست هر واحد */
  originalPrice: number;
  /** قیمت هر واحد پس از فروش ویژه */
  salePrice: number;
  /** تخفیف پروموشن روی کل این ردیف (نه هر واحد) */
  promotionDiscount?: number;
  isFreeReward?: boolean;
  promotionRewardId?: number | null;
  promotionLabel?: string | null;
  promotionIds?: number[];
  title?: string;
}

export interface CheckoutTotals {
  /** جمع قیمت فهرست */
  originalPrice: number;
  /** تخفیف فروش ویژه */
  saleDiscount: number;
  /** تخفیف پروموشن‌ها */
  promotionDiscount: number;
  /** ارزش کالاهای رایگان */
  freeItemValue: number;
  /** جمع تخفیف کد (بعداً اعمال می‌شود) */
  codeDiscount: number;
  shippingCost: number;
  freeShippingApplied: boolean;
  /** مبلغ نهایی قابل پرداخت */
  finalPrice: number;
  lines: CheckoutLineResult[];
  /** بررسی سازگاری: تفاوت جمع خطوط با جمع کل صفر باشد */
  consistency: { ok: boolean; difference: number };
}

export interface CheckoutLineResult {
  lineId: number | string;
  quantity: number;
  originalPrice: number;
  salePrice: number;
  /** مبلغ پرداختی هر واحد پس از همهٔ تخفیف‌های ردیف */
  payablePerUnit: number;
  payableTotal: number;
  promotionDiscount: number;
  isFreeReward: boolean;
  promotionRewardId: number | null;
  promotionLabel: string | null;
  promotionIds: number[];
}

export function calculateCheckoutTotals(input: {
  lines: CheckoutLineInput[];
  shippingCost: number;
  freeShipping?: boolean;
  codeDiscount?: number;
}): CheckoutTotals {
  const lines: CheckoutLineResult[] = [];

  let originalPrice = 0;
  let saleDiscount = 0;
  let promotionDiscount = 0;

  for (const line of input.lines) {
    const quantity = Math.max(0, Math.floor(Number(line.quantity) || 0));
    const list = round(line.originalPrice) * quantity;
    const sale = round(line.salePrice);

    const lineSaleDiscount = Math.max(
      0,
      round((round(line.originalPrice) - sale) * quantity),
    );

    const linePromotionDiscount = Math.max(
      0,
      Math.min(round(line.promotionDiscount ?? 0), sale * quantity),
    );

    const payableTotal = Math.max(
      0,
      sale * quantity - linePromotionDiscount,
    );

    originalPrice += list;
    saleDiscount += lineSaleDiscount;
    promotionDiscount += linePromotionDiscount;

    lines.push({
      lineId: line.lineId,
      quantity,
      originalPrice: round(line.originalPrice),
      salePrice: sale,
      payablePerUnit:
        quantity > 0 ? Math.round(payableTotal / quantity) : 0,
      payableTotal,
      promotionDiscount: linePromotionDiscount,
      isFreeReward: !!line.isFreeReward,
      promotionRewardId: line.promotionRewardId ?? null,
      promotionLabel: line.promotionLabel ?? null,
      promotionIds: line.promotionIds ?? [],
    });
  }

  // ارزش کالای رایگان = قیمت فروش همان ردیف (همان چیزی که در سبد نشان
  // داده می‌شود) — نه مبلغ قابل پرداخت آن که صفر است.
  const freeItemValue = lines
    .filter(line => line.isFreeReward)
    .reduce((sum, line) => sum + line.salePrice * line.quantity, 0);

  const codeDiscount = Math.max(0, round(input.codeDiscount ?? 0));
  const shippingCost = input.freeShipping ? 0 : round(input.shippingCost);

  const subtotalAfterDiscounts = Math.max(
    0,
    originalPrice - saleDiscount - promotionDiscount - codeDiscount,
  );

  const finalPrice = Math.max(0, subtotalAfterDiscounts + shippingCost);

  // بررسی سازگاری: جمع مبلغ خطوط = جمع اقلام نهایی (بدون ارسال)
  const linesTotal = lines.reduce((sum, line) => sum + line.payableTotal, 0);
  const expectedLinesTotal = Math.max(0, subtotalAfterDiscounts);
  const difference = linesTotal - expectedLinesTotal;

  return {
    originalPrice,
    saleDiscount,
    promotionDiscount,
    freeItemValue,
    codeDiscount,
    shippingCost,
    freeShippingApplied: !!input.freeShipping,
    finalPrice,
    lines,
    consistency: { ok: Math.abs(difference) < 1, difference },
  };
}

/** ساخت اسنپ‌شات پروموشن برای ذخیره روی سفارش */
export function buildPromotionSnapshot(
  evaluations: PromotionEvaluation[],
  variantIdsByLine: Map<string, number | null>,
): NonNullable<import('./entities/order.entity').Order['promotionSnapshot']> {
  return evaluations.map(evaluation => {
    const qualifyingVariantIds = new Set<number>();
    const rewardVariantIds = new Set<number>();

    for (const allocation of evaluation.allocations) {
      const variantId = variantIdsByLine.get(String(allocation.lineId));

      if (variantId == null) {
        continue;
      }

      if (allocation.isFree) {
        rewardVariantIds.add(variantId);
      } else {
        qualifyingVariantIds.add(variantId);
      }
    }

    for (const item of evaluation.freeItems) {
      if (item.variantId != null) {
        rewardVariantIds.add(item.variantId);
      }
    }

    return {
      promotionId: evaluation.promotionId,
      name: evaluation.name,
      type: evaluation.type,
      discountAmount: evaluation.discountAmount,
      freeItemValue: evaluation.freeItemValue,
      grantsFreeShipping: evaluation.grantsFreeShipping,
      qualifyingVariantIds: [...qualifyingVariantIds],
      rewardVariantIds: [...rewardVariantIds],
      rewardProductIds: evaluation.freeItems.map(item => item.productId),
      lines: evaluation.allocations.map(allocation => ({
        lineId: String(allocation.lineId),
        amount: allocation.amount,
        isFree: allocation.isFree,
        label: allocation.label,
      })),
    };
  });
}

function round(value: number): number {
  const parsed = Number(value ?? 0);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.round(parsed);
}
