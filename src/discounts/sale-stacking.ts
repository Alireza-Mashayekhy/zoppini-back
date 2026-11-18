import { DiscountType } from './entities/discount.entity';

/**
 * موتور خالصِ «تخفیف‌های متوالی» (Sequential / Stacked discounts).
 *
 * هر مرحله روی «مبلغ باقی‌مانده از مرحلهٔ قبل» اعمال می‌شود، نه روی قیمت اولیه:
 *
 *   FinalPrice = OriginalPrice × (1 − d1/100) × (1 − d2/100) × …
 *
 * قواعد ثابت (برای اینکه نتیجه در همهٔ بخش‌های سایت یکسان و قابل پیش‌بینی باشد):
 *  1. تخفیف‌های «غیر متوالی» (stackable = false) مانند قبل رفتار می‌کنند: فقط
 *     بهترین‌شان (بیشترین مبلغ تخفیف) انتخاب می‌شود و بقیه اعمال نمی‌شوند.
 *  2. به‌محض وجود دست‌کم یک تخفیف متوالیِ مشمول، ابتدا بهترین تخفیف قدیمی
 *     (غیر متوالی) و سپس تخفیف‌های متوالی به ترتیب `stackPriority` صعودی
 *     (و در صورت تساوی، شناسهٔ صعودی) روی مبلغ باقی‌مانده اعمال می‌شوند.
 *  3. هر تخفیف حداکثر یک بار و فقط اگر فعال و در بازهٔ اعتبار باشد اعمال می‌شود.
 *  4. مبلغ تخفیف هر مرحله از مبلغ باقی‌مانده بیشتر نمی‌شود؛ قیمت نهایی هرگز
 *     منفی نمی‌شود.
 *  5. درصد نامعتبر (کمتر از صفر یا بیشتر از ۱۰۰) در محاسبه پذیرفته نمی‌شود.
 *
 * این ماژول هیچ وابستگی به دیتابیس ندارد تا مستقیماً تست شود؛ سرویس تخفیف
 * فقط دادهٔ دیتابیس را به این توابع می‌دهد تا «یک منبع حقیقت» باقی بماند.
 */

export interface DiscountValueSource {
  type: DiscountType;
  value: number | string;
  maxDiscountAmount?: number | string | null;
}

export interface SaleScopeSource {
  /** اگر true باشد، تخفیف روی همهٔ محصولات اعمال می‌شود */
  appliesToAllProducts?: boolean | null;
  products?: { id: number }[] | null;
  /** دسته‌های مشمول + همهٔ زیرمجموعه‌ها (از سرویس پر می‌شود) */
  scopeCategoryIds?: Set<number> | number[] | null;
}

export interface SequentialSaleSource
  extends DiscountValueSource, SaleScopeSource {
  id: number;
  stackable?: boolean | null;
  stackPriority?: number | string | null;
  isActive?: boolean | null;
  startsAt?: Date | string | null;
  expiresAt?: Date | string | null;
}

export interface AppliedDiscountStage<T extends DiscountValueSource> {
  discount: T;
  /** مبلغ تخفیف این مرحله (روی مبلغ باقی‌ماندهٔ قبل از خودش) */
  discountAmount: number;
  /** مبلغ باقی‌مانده قبل از این مرحله */
  priceBefore: number;
  /** مبلغ باقی‌مانده بعد از این مرحله */
  priceAfter: number;
}

export interface SequentialDiscountResult<T extends DiscountValueSource> {
  stages: AppliedDiscountStage<T>[];
  discountAmount: number;
  finalPrice: number;
  /** true اگر بیش از یک مرحله اعمال شده باشد */
  stacked: boolean;
  /** درصد تخفیف مؤثر (گرد‌شده) برای نمایش */
  effectivePercent: number;
}

/**
 * مبلغ تخفیف یک مرحله روی یک مبلغ مشخص.
 *
 * - درصدی: value٪ از مبلغ (درصدهای خارج از بازهٔ ۰..۱۰۰ نادیده گرفته می‌شوند)
 * - مبلغ ثابت: value تومان
 * - سقف `maxDiscountAmount` رعایت می‌شود
 * - مبلغ تخفیف هرگز از خود مبلغ بیشتر نمی‌شود
 */
export function calculateStageDiscount(
  source: DiscountValueSource,
  amount: number,
): number {
  const base = Number(amount);

  if (!Number.isFinite(base) || base <= 0) {
    return 0;
  }

  const value = Number(source.value);

  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  let discountAmount = 0;

  if (source.type === DiscountType.PERCENTAGE) {
    // درصد نامعتبر (بیش از ۱۰۰) به ۱۰۰ محدود می‌شود؛ نتیجه هرگز منفی نیست.
    const percent = Math.min(100, value);

    discountAmount = (base * percent) / 100;
  } else if (source.type === DiscountType.FIXED) {
    discountAmount = value;
  } else {
    return 0;
  }

  const cap = Number(source.maxDiscountAmount);

  if (
    source.maxDiscountAmount !== null &&
    source.maxDiscountAmount !== undefined &&
    Number.isFinite(cap) &&
    cap >= 0
  ) {
    discountAmount = Math.min(discountAmount, cap);
  }

  discountAmount = Math.min(discountAmount, base);

  return Math.max(0, discountAmount);
}

/** تخفیف در همین لحظه فعال است؟ (فعال + داخل بازهٔ تاریخ) */
export function isSaleActiveAt(
  sale: Pick<SequentialSaleSource, 'isActive' | 'startsAt' | 'expiresAt'>,
  now: Date = new Date(),
): boolean {
  // `0` هم (مقدار خام MySQL برای boolean) غیرفعال حساب می‌شود.
  if (sale.isActive !== undefined && sale.isActive !== null && !sale.isActive) {
    return false;
  }

  const startsAt = sale.startsAt ? new Date(sale.startsAt) : null;
  const expiresAt = sale.expiresAt ? new Date(sale.expiresAt) : null;

  if (startsAt && !Number.isNaN(startsAt.getTime()) && now < startsAt) {
    return false;
  }

  if (expiresAt && !Number.isNaN(expiresAt.getTime()) && now > expiresAt) {
    return false;
  }

  return true;
}

/** محصول در دامنهٔ این تخفیف قرار دارد؟ */
export function isProductInSaleScope(
  sale: SaleScopeSource,
  productId: number,
  categoryIds: readonly number[],
): boolean {
  if (sale.appliesToAllProducts) {
    return true;
  }

  if ((sale.products ?? []).some(product => product.id === productId)) {
    return true;
  }

  const scope =
    sale.scopeCategoryIds instanceof Set
      ? sale.scopeCategoryIds
      : new Set(sale.scopeCategoryIds ?? []);

  return categoryIds.some(id => scope.has(id));
}

function normalizePriority(sale: SequentialSaleSource): number {
  const priority = Number(sale.stackPriority);

  return Number.isFinite(priority) ? priority : 0;
}

/**
 * ترتیب نهایی اعمال تخفیف‌ها برای یک محصول.
 *
 * خروجی: آرایهٔ مرتب‌شدهٔ تخفیف‌هایی که باید یکی‌یکی روی مبلغ باقی‌مانده
 * اعمال شوند. اگر هیچ تخفیف متوالیِ مشمولی وجود نداشته باشد، رفتار قدیمی
 * (فقط بهترین تخفیف غیر متوالی) حفظ می‌شود.
 */
export function resolveSequentialSaleChain<T extends SequentialSaleSource>(
  sales: readonly T[],
  productId: number,
  categoryIds: readonly number[],
  originalPrice: number,
  now: Date = new Date(),
): T[] {
  const applicable = sales.filter(
    sale =>
      isSaleActiveAt(sale, now) &&
      isProductInSaleScope(sale, productId, categoryIds),
  );

  const legacySales = applicable
    .filter(sale => !sale.stackable)
    .sort((first, second) => first.id - second.id);

  const stackableSales = applicable
    .filter(sale => !!sale.stackable)
    .sort((first, second) => {
      const byPriority = normalizePriority(first) - normalizePriority(second);

      return byPriority !== 0 ? byPriority : first.id - second.id;
    });

  const bestLegacy = pickBestLegacySale(legacySales, originalPrice);

  if (!stackableSales.length) {
    return bestLegacy ? [bestLegacy] : [];
  }

  // تخفیف قدیمی (غیر متوالی) نقش «پایه» را دارد و اول اعمال می‌شود؛
  // سپس مراحل متوالی به ترتیب اولویت روی مبلغ باقی‌مانده می‌آیند.
  const ordered: T[] = [];

  if (bestLegacy) {
    ordered.push(bestLegacy);
  }

  const seen = new Set<number>();

  for (const sale of stackableSales) {
    if (seen.has(sale.id)) {
      continue;
    }

    seen.add(sale.id);
    ordered.push(sale);
  }

  return ordered;
}

/**
 * بهترین تخفیف غیر متوالی: بیشترین مبلغ تخفیف روی قیمت اولیه.
 * در تساوی، شناسهٔ کوچک‌تر (پایدار) انتخاب می‌شود.
 */
export function pickBestLegacySale<T extends SequentialSaleSource>(
  sales: readonly T[],
  originalPrice: number,
): T | null {
  let best: T | null = null;
  let bestAmount = 0;

  for (const sale of sales) {
    const amount = calculateStageDiscount(sale, originalPrice);

    if (amount <= 0) {
      continue;
    }

    if (!best || amount > bestAmount) {
      best = sale;
      bestAmount = amount;
    }
  }

  return best;
}

/**
 * اعمال تخفیف‌های مرتب‌شده به‌صورت متوالی روی قیمت اولیه.
 * هر مرحله فقط روی مبلغ باقی‌ماندهٔ مرحلهٔ قبل اثر می‌گذارد.
 */
export function applySequentialDiscounts<T extends SequentialSaleSource>(
  originalPrice: number,
  chain: readonly T[],
): SequentialDiscountResult<T> {
  const stages: AppliedDiscountStage<T>[] = [];

  const safeOriginal = Number(originalPrice);

  let remaining =
    Number.isFinite(safeOriginal) && safeOriginal > 0 ? safeOriginal : 0;

  const initial = remaining;

  for (const sale of chain) {
    const priceBefore = remaining;
    const discountAmount = calculateStageDiscount(sale, priceBefore);

    if (discountAmount <= 0) {
      continue;
    }

    remaining = Math.max(0, priceBefore - discountAmount);

    stages.push({
      discount: sale,
      discountAmount,
      priceBefore,
      priceAfter: remaining,
    });
  }

  const discountAmount = Math.max(0, initial - remaining);

  return {
    stages,
    discountAmount,
    finalPrice: remaining,
    stacked: stages.length > 1,
    effectivePercent:
      initial > 0 ? Math.round((discountAmount / initial) * 100) : 0,
  };
}

/**
 * زنجیره + محاسبه در یک فراخوانی؛ برای استفاده در سرویس و تست.
 */
export function resolveSequentialDiscountForProduct<
  T extends SequentialSaleSource,
>(
  sales: readonly T[],
  params: {
    productId: number;
    categoryIds: readonly number[];
    originalPrice: number;
    now?: Date;
  },
): SequentialDiscountResult<T> | null {
  const chain = resolveSequentialSaleChain(
    sales,
    params.productId,
    params.categoryIds,
    params.originalPrice,
    params.now ?? new Date(),
  );

  if (!chain.length) {
    return null;
  }

  const result = applySequentialDiscounts(params.originalPrice, chain);

  return result.stages.length ? result : null;
}
