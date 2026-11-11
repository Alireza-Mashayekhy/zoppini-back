import {
  FreeItemSelection,
  Promotion,
  PromotionRewardType,
  PromotionScope,
  PromotionType,
} from '../entities/promotion.entity';

/**
 * موتور محاسبهٔ پروموشن‌ها.
 *
 * این فایل «خالص» است (بدون TypeORM/Database) تا همان منطقی که سبد،
 * پاپ‌آپ، صفحهٔ محصول، چک‌اوت و ثبت سفارش استفاده می‌کنند در تست‌ها هم
 * دقیقاً اجرا شود. هر جا عددی از قیمت‌ها محاسبه می‌شود، گرد کردن فقط در
 * لایهٔ همین فایل انجام می‌شود تا اعداد سبد/چک‌اوت/سفارش یکی باشند.
 */

/** یک واحد قابل فروش در سبد (هر ردیف با quantity به واحدها بسط داده می‌شود) */
export interface PromotionCartLine {
  /** شناسهٔ ردیف سبد یا کلید یکتای ردیف مجازی */
  lineId: string | number;
  variantId: number | null;
  productId: number;
  categoryIds: number[];
  /** قیمت واحد پس از فروش ویژه (مبلغی که مشتری پای صندوق می‌پردازد) */
  unitPrice: number;
  /** قیمت فهرست (قبل از فروش ویژه)؛ برای پروموشن مبنای محاسبه است */
  listPrice?: number;
  quantity: number;
  /**
   * ترتیب افزودن به سبد. برای ردیف‌های متعدد، واحدهای یک ردیف با
   * شماره‌های متوالی بسط داده می‌شوند تا «آخرین افزوده‌شده» دقیق باشد.
   */
  addedAt: number;
  title?: string;
  image?: string | null;
  slug?: string;
  stock?: number;
  colorName?: string;
  sizeName?: string;
  /** ردیفی که خودش پاداش رایگان پروموشن است (نباید دوباره محرک شود) */
  isFreeReward?: boolean;
  /** پروموشنی که این ردیف را رایگان کرده است */
  rewardPromotionId?: number | null;
}

/** یک واحد بسط‌یافته از سبد (برای الگوریتم «ارزان‌ترین در هر جفت») */
export interface ExpandedUnit {
  lineId: string | number;
  variantId: number | null;
  productId: number;
  categoryIds: number[];
  unitPrice: number;
  listPrice: number;
  /** ترتیب افزودن؛ بزرگ‌تر = جدیدتر */
  addedAt: number;
  /** شمارهٔ واحد در همان ردیف (برای تمایز واحدهای هم‌قیمت) */
  unitIndex: number;
  quantity: number;
}

export interface PromotionDiscountAllocation {
  lineId: string | number;
  variantId: number | null;
  productId: number;
  /** پروموشنی که این تخفیف/رایگان‌بودن را ایجاد کرده (برای ردیف‌های سبد) */
  promotionId?: number;
  /** مقدار تخفیف این ردیف (تومان) */
  amount: number;
  /** تعداد واحدهای تخفیف‌خورده */
  discountedUnits: number;
  /** کالای رایگان است؟ */
  isFree: boolean;
  /** توضیح یک‌خطی برای نمایش روی ردیف سبد */
  label: string;
}

export interface PromotionEvaluation {
  promotionId: number;
  name: string;
  type: PromotionType;
  /** آیا شرط‌ها احراز شده و این پروموشن باید اعمال شود؟ */
  qualifies: boolean;
  /** جمع تخفیف نقدی (بدون ارزش کالای رایگان جدا محاسبه می‌شود) */
  discountAmount: number;
  /** جمع ارزش کالاهای رایگان */
  freeItemValue: number;
  /** ارسال رایگان؟ */
  grantsFreeShipping: boolean;
  /** تخفیف به تفکیک ردیف سبد */
  allocations: PromotionDiscountAllocation[];
  /** کالاهای رایگانی که باید در سبد باشد/به آن اضافه شود */
  freeItems: PromotionFreeItem[];
  /** دلیل عدم احراز (برای نمایش شفاف به مشتری و لاگ پشتیبانی) */
  reasons: string[];
  /** توضیح قابل نمایش به مشتری */
  message: string | null;
  /** آیا پاداش هنوز به سبد اضافه نشده و نیاز به اقدام مشتری دارد؟ */
  requiresAction: boolean;
  /** آیا پاداش باید خودکار اضافه شود */
  autoAddReward: boolean;
  /** آیا با پارامترهای دیگر قابل ترکیب است (توسط هماهنگ‌کننده تعیین می‌شود) */
  canStack: boolean;
}

export interface PromotionFreeItem {
  productId: number;
  variantId: number | null;
  quantity: number;
  title?: string;
  slug?: string;
  image?: string | null;
  unitPrice: number;
}

/** نتیجهٔ نهایی همهٔ پروموشن‌های فعال روی سبد */
export interface PromotionCartResult {
  /** جمع تخفیف پروموشن‌های اعمال‌شده */
  totalDiscount: number;
  /** جمع ارزش کالاهای رایگان */
  totalFreeItemValue: number;
  /** آیا سفارش ارسال رایگان دارد */
  freeShipping: boolean;
  /** پروموشن‌هایی که واقعاً اعمال شدند */
  applied: PromotionEvaluation[];
  /** پروموشن‌هایی که شرطشان احراز نشده یا کنار گذاشته شدند */
  rejected: PromotionEvaluation[];
  /** پروموشن‌های فعال برای نشان دادن به‌عنوان «با این خرید X تومان صرفه‌جویی کن» */
  suggestions: PromotionSuggestion[];
  /** مشکل‌هایی که باید به مشتری گفته شود (منقضی/ناموجود/...) */
  notices: string[];
}

export interface PromotionSuggestion {
  promotionId: number;
  title: string;
  description: string | null;
  badgeText: string | null;
  /** توضیح دقیق این‌که با افزودن چه چیزی چه چیزی گیرش می‌آید */
  hint: string;
  /** محصول پیشنهادی برای افزودن */
  suggestedProduct: {
    productId: number;
    variantId: number | null;
    title?: string;
    image?: string | null;
    slug?: string;
    price?: number;
  } | null;
  suggestedCategoryId: number | null;
  acceptLabel: string | null;
  dismissLabel: string | null;
  /** آیا با هم‌اکنون پذیرش، کالا رایگان می‌شود */
  rewardIsFree: boolean;
  /** آیا مشتری باید از بین چند گزینه انتخاب کند */
  requiresSelection: boolean;
  /**
   * نوع اقدامی که دکمهٔ اصلی پاپ‌آپ انجام می‌دهد.
   *
   * - `add_free_reward`: هدیهٔ رایگان به سبد اضافه می‌شود (مسیر پاداش).
   * - `add_paid_item`: کالای عادی و پولی برای کامل‌کردن شرط (خرید X، دریافت
   *   Y؛ خرید به‌اندازه). هرگز نباید با مسیر پاداش اضافه شود، وگرنه کالای
   *   پولی به‌عنوان هدیه نمایش داده می‌شود.
   * - `open_cart`: فقط راهنمایی است و مشتری خودش از سبد/صفحهٔ محصول ادامه
   *   می‌دهد.
   */
  action: 'add_free_reward' | 'add_paid_item' | 'open_cart';
  /** شناسهٔ یکتای این وضعیت برای «یک بار نمایش» */
  stateKey: string;
}

// =========================================================
// ابزارهای عددی
// =========================================================

/** تومان — همیشه رند به تومان */
export function toToman(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.round(parsed));
}

function percentOf(value: number, percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) {
    return 0;
  }

  return Math.round((value * Math.min(100, percent)) / 100);
}

function clampPercent(value: number | null | undefined): number {
  const parsed = Number(value ?? 0);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.min(100, Math.max(0, parsed));
}

// =========================================================
// زمان و شمول
// =========================================================

/** آیا دامنهٔ شمول، همهٔ محصولات را در بر می‌گیرد */
export function scopeMatchesAll(scope: PromotionScope | null | undefined) {
  return scope === PromotionScope.ALL || scope == null;
}

export function promotionWindowState(
  promotion: Pick<Promotion, 'isActive' | 'startsAt' | 'expiresAt'>,
  now: Date,
): 'inactive' | 'scheduled' | 'expired' | 'live' {
  if (!promotion.isActive) {
    return 'inactive';
  }

  const startsAt = new Date(promotion.startsAt).getTime();
  const expiresAt = new Date(promotion.expiresAt).getTime();
  const ts = now.getTime();

  if (Number.isFinite(startsAt) && ts < startsAt) {
    return 'scheduled';
  }

  if (Number.isFinite(expiresAt) && ts > expiresAt) {
    return 'expired';
  }

  return 'live';
}

export function isPromotionLive(
  promotion: Pick<Promotion, 'isActive' | 'startsAt' | 'expiresAt'>,
  now: Date = new Date(),
): boolean {
  return promotionWindowState(promotion, now) === 'live';
}

/**
 * آیا محصول با دامنهٔ شمول پروموشن جور است.
 *
 * `excludedCategories`/`excludedProducts` همیشه بر شمول مقدم‌اند.
 */
export function isProductInScope(
  promotion: Pick<
    Promotion,
    'scope' | 'products' | 'categories' | 'excludedProducts' | 'excludedCategories'
  >,
  productId: number,
  categoryIds: number[],
  expandedCategoryIds?: {
    products: Set<number>;
    categories: Set<number>;
    excludedProducts: Set<number>;
    excludedCategories: Set<number>;
  },
): boolean {
  const excludedProducts = new Set(
    (promotion.excludedProducts ?? []).map(product => product.id),
  );
  const excludedCategories = new Set(
    (promotion.excludedCategories ?? []).map(category => category.id),
  );
  const excludedProductIds = new Set([
    ...excludedProducts,
    ...(expandedCategoryIds?.excludedProducts ?? []),
  ]);
  const excludedCategoryIds = new Set([
    ...excludedCategories,
    ...(expandedCategoryIds?.excludedCategories ?? []),
  ]);

  if (excludedProductIds.has(productId)) {
    return false;
  }

  if (categoryIds.some(id => excludedCategoryIds.has(id))) {
    return false;
  }

  if (scopeMatchesAll(promotion.scope)) {
    return true;
  }

  const productIds = new Set([
    ...(promotion.products ?? []).map(product => product.id),
    ...(expandedCategoryIds?.products ?? []),
  ]);
  const categoryIdSet = new Set([
    ...(promotion.categories ?? []).map(category => category.id),
    ...(expandedCategoryIds?.categories ?? []),
  ]);

  if (productIds.has(productId)) {
    return true;
  }

  return categoryIds.some(id => categoryIdSet.has(id));
}

/**
 * آیا محصول با «دامنهٔ پاداش» (فیلدهای reward*) جور است.
 * برای نوع C و پاپ‌آپ‌ها استفاده می‌شود.
 */
export function isProductInRewardScope(
  promotion: Pick<
    Promotion,
    | 'rewardScope'
    | 'rewardProducts'
    | 'rewardCategories'
    | 'suggestedProductId'
    | 'suggestedCategoryId'
    | 'products'
    | 'categories'
    | 'excludedProducts'
    | 'excludedCategories'
  >,
  productId: number,
  categoryIds: number[],
  expandedCategoryIds?: {
    rewardProducts: Set<number>;
    rewardCategories: Set<number>;
    excludedProducts: Set<number>;
    excludedCategories: Set<number>;
  },
): boolean {
  const excludedProductIds = new Set([
    ...(promotion.excludedProducts ?? []).map(product => product.id),
    ...(expandedCategoryIds?.excludedProducts ?? []),
  ]);
  const excludedCategoryIds = new Set([
    ...(promotion.excludedCategories ?? []).map(category => category.id),
    ...(expandedCategoryIds?.excludedCategories ?? []),
  ]);

  if (excludedProductIds.has(productId)) {
    return false;
  }

  if (categoryIds.some(id => excludedCategoryIds.has(id))) {
    return false;
  }

  if (promotion.rewardScope === PromotionScope.ALL) {
    return true;
  }

  if (!promotion.rewardScope) {
    // دامنهٔ پاداش تعریف نشده: پیشنهادی‌ها یا همان دامنهٔ محرک
    if (
      promotion.suggestedProductId != null &&
      promotion.suggestedProductId === productId
    ) {
      return true;
    }

    if (
      promotion.suggestedCategoryId != null &&
      categoryIds.includes(promotion.suggestedCategoryId)
    ) {
      return true;
    }

    return isProductInScope(promotion as Promotion, productId, categoryIds);
  }

  const productIds = new Set([
    ...(promotion.rewardProducts ?? []).map(product => product.id),
    ...(expandedCategoryIds?.rewardProducts ?? []),
  ]);
  const categoryIdsSet = new Set([
    ...(promotion.rewardCategories ?? []).map(category => category.id),
    ...(expandedCategoryIds?.rewardCategories ?? []),
  ]);

  if (productIds.has(productId)) {
    return true;
  }

  return categoryIds.some(id => categoryIdsSet.has(id));
}

// =========================================================
// بسط سبد به واحدها
// =========================================================

/**
 * هر ردیف سبد را به تعداد quantity واحد بسط می‌دهد.
 *
 * ردیف‌های یکسان (same variant) ادغام نمی‌شوند تا «زمان افزودن» هر واحد
 * حفظ شود. برای ردیف با quantity>1، واحدهای بعدی زمان جدیدتری می‌گیرند.
 */
export function expandCartLines(
  lines: PromotionCartLine[],
  options: { includeFreeRewards?: boolean } = {},
): ExpandedUnit[] {
  const units: ExpandedUnit[] = [];
  const includeFree = options.includeFreeRewards ?? false;

  for (const line of lines) {
    if (line.isFreeReward && !includeFree) {
      continue;
    }

    const quantity = Math.max(0, Math.floor(Number(line.quantity) || 0));
    const unitPrice = toToman(line.unitPrice);

    for (let index = 0; index < quantity; index += 1) {
      units.push({
        lineId: line.lineId,
        variantId: line.variantId,
        productId: line.productId,
        categoryIds: line.categoryIds ?? [],
        unitPrice,
        listPrice: toToman(line.listPrice ?? line.unitPrice),
        addedAt: Number(line.addedAt ?? 0) + index,
        unitIndex: index,
        quantity,
      });
    }
  }

  return units;
}

/**
 * مرتب‌سازی قطعی «ارزان‌ترین واحد» برای تخفیف:
 * 1) قیمت واحد صعودی
 * 2) زمان افزودن نزولی (جدیدتر = اولویت بیشتر)
 * 3) unitIndex نزولی (واحد آخرِ یک ردیف، جدیدتر است)
 * 4) lineId برای پایداری کامل
 */
export function orderDiscountCandidates<T extends ExpandedUnit>(
  units: T[],
): T[] {
  return [...units].sort((a, b) => {
    if (a.unitPrice !== b.unitPrice) {
      return a.unitPrice - b.unitPrice;
    }

    if (a.addedAt !== b.addedAt) {
      return b.addedAt - a.addedAt;
    }

    if (a.unitIndex !== b.unitIndex) {
      return b.unitIndex - a.unitIndex;
    }

    return String(b.lineId).localeCompare(String(a.lineId));
  });
}

// =========================================================
// ساخت نتیجهٔ پایه
// =========================================================

function emptyEvaluation(
  promotion: Promotion,
  reasons: string[] = [],
): PromotionEvaluation {
  return {
    promotionId: promotion.id,
    name: promotion.name,
    type: promotion.type,
    qualifies: false,
    discountAmount: 0,
    freeItemValue: 0,
    grantsFreeShipping: false,
    allocations: [],
    freeItems: [],
    reasons,
    message: null,
    requiresAction: false,
    autoAddReward: false,
    canStack: promotion.canStack ?? false,
  };
}

function mergeAllocations(
  allocations: PromotionDiscountAllocation[],
): PromotionDiscountAllocation[] {
  const byLine = new Map<string, PromotionDiscountAllocation>();

  for (const allocation of allocations) {
    if (allocation.amount <= 0 && !allocation.isFree) {
      continue;
    }

    const key = `${allocation.lineId}:${allocation.isFree ? 'free' : 'discount'}:${allocation.promotionId ?? ''}`;
    const existing = byLine.get(key);

    if (existing) {
      existing.amount += allocation.amount;
      existing.discountedUnits += allocation.discountedUnits;
      continue;
    }

    byLine.set(key, { ...allocation });
  }

  return [...byLine.values()];
}

// =========================================================
// نوع A — خرید زوج و تخفیف ارزان‌تر
// =========================================================

/**
 * برای هر `pairSize` واحد مشمول، `floor(... / pairSize)` واحد تخفیف می‌گیرد
 * و آن واحدها ارزان‌ترین واحدها هستند؛ در قیمت مساوی، واحدهای جدیدتر.
 */
export function evaluateCheaperItemPair(
  promotion: Promotion,
  units: ExpandedUnit[],
): PromotionEvaluation {
  const evaluation = emptyEvaluation(promotion);

  const eligible = units.filter(unit =>
    isProductInScope(promotion, unit.productId, unit.categoryIds),
  );

  const pairSize = Math.max(2, Math.floor(promotion.pairSize || 2));
  const percent = clampPercent(Number(promotion.rewardValue ?? 0));

  const eligibleQuantity = eligible.length;
  const discountedUnitCount = promotion.discountEveryExtraUnit
    ? Math.max(0, eligibleQuantity - 1)
    : Math.floor(eligibleQuantity / pairSize);

  if (eligibleQuantity < pairSize) {
    evaluation.reasons.push(
      `برای فعال شدن این پروموشن حداقل ${pairSize} کالای مشمول لازم است (اکنون ${eligibleQuantity}).`,
    );
    evaluation.message = `${pairSize - eligibleQuantity} کالای مشمول دیگر اضافه کنید تا تخفیف فعال شود.`;

    return evaluation;
  }

  if (discountedUnitCount <= 0) {
    evaluation.reasons.push('تعداد کالاهای مشمول به یک جفت کامل نمی‌رسد.');
    return evaluation;
  }

  const ordered = orderDiscountCandidates(eligible);
  const chosen = ordered.slice(0, discountedUnitCount);

  const allocations: PromotionDiscountAllocation[] = [];

  for (const unit of chosen) {
    const discount = percentOf(unit.unitPrice, percent);

    if (discount <= 0) {
      continue;
    }

    allocations.push({
      lineId: unit.lineId,
      variantId: unit.variantId,
      productId: unit.productId,
      amount: discount,
      discountedUnits: 1,
      isFree: false,
      label: `${percent}٪ تخفیف روی ارزان‌ترین کالا`,
    });
  }

  const merged = mergeAllocations(allocations);

  evaluation.qualifies = merged.length > 0;
  evaluation.allocations = merged;
  evaluation.discountAmount = merged.reduce(
    (sum, allocation) => sum + allocation.amount,
    0,
  );
  evaluation.message =
    promotion.badgeText?.trim() ||
    `روی ${discountedUnitCount} کالا از ${eligibleQuantity} کالای مشمول، ${percent}٪ تخفیف اعمال شد.`;

  return evaluation;
}

// =========================================================
// نوع B — خرید X، دریافت Y از همان گروه
// =========================================================

/**
 * با داشتن X+Y کالای مشمول، Y کالای ارزان‌تر رایگان می‌شوند.
 *
 * در قیمت مساوی، جدیدترین واحدها رایگان می‌شوند (قاعدهٔ یکسان با نوع A).
 */
export function evaluateBuyXGetY(
  promotion: Promotion,
  units: ExpandedUnit[],
): PromotionEvaluation {
  const evaluation = emptyEvaluation(promotion);

  const eligible = units.filter(unit =>
    isProductInScope(promotion, unit.productId, unit.categoryIds),
  );

  const required = Math.max(1, Math.floor(promotion.requiredQuantity || 1));
  const freeQuantity = Math.max(1, Math.floor(promotion.freeQuantity || 1));
  const eligibleQuantity = eligible.length;

  if (eligibleQuantity < required + freeQuantity) {
    evaluation.reasons.push(
      `این پیشنهاد با ${required + freeQuantity} کالای مشمول فعال می‌شود (اکنون ${eligibleQuantity}).`,
    );
    evaluation.message = `${required + freeQuantity - eligibleQuantity} کالای مشمول دیگر اضافه کنید و ${freeQuantity} کالا رایگان بگیرید.`;

    return evaluation;
  }

  const ordered = orderDiscountCandidates(eligible);
  const paid = ordered.slice(freeQuantity);
  const free = ordered.slice(0, freeQuantity);

  const allocations: PromotionDiscountAllocation[] = [];
  const freeItems: PromotionFreeItem[] = [];

  for (const unit of free) {
    allocations.push({
      lineId: unit.lineId,
      variantId: unit.variantId,
      productId: unit.productId,
      amount: unit.unitPrice,
      discountedUnits: 1,
      isFree: true,
      label: 'رایگان (پاداش خرید)',
    });

    freeItems.push({
      productId: unit.productId,
      variantId: unit.variantId,
      quantity: 1,
      unitPrice: unit.unitPrice,
    });
  }

  const merged = mergeAllocations(allocations);

  evaluation.qualifies = merged.length > 0;
  evaluation.allocations = merged;
  evaluation.freeItems = freeItems;
  evaluation.freeItemValue = merged.reduce(
    (sum, allocation) => sum + allocation.amount,
    0,
  );
  evaluation.message = `با خرید ${required} کالا، ${freeQuantity} کالای ارزان‌تر رایگان شد.`;

  // اطلاعات کمکی برای نمایش «کدام کالا رایگان شد»
  void paid;

  return evaluation;
}

// =========================================================
// نوع C — محرک و پاداش متفاوت
// =========================================================

export interface BuyTriggerRewardOptions {
  /** آیا مشتری پاداش را پذیرفته است */
  rewardAccepted?: boolean;
  /** کالای پاداش انتخاب‌شده توسط مشتری */
  selectedReward?: { productId: number; variantId: number | null } | null;
  /** کالاهای رایگان موجود در سبد که قبلاً برای این پروموشن اضافه شده‌اند */
  existingRewards?: PromotionCartLine[];
  /** برای بررسی موجودی: stock هر واریانت (اگر ناشناخته باشد Infinity) */
  variantStock?: (variantId: number | null, productId: number) => number;
  /** قیمت واحد محصولات (برای ارزش کالای رایگان) */
  priceOf?: (productId: number, variantId: number | null) => number;
  /** آیا پاداش خارج از موجودی است */
  isRewardOutOfStock?: (productId: number, variantId: number | null) => boolean;
}

export function evaluateTriggerReward(
  promotion: Promotion,
  units: ExpandedUnit[],
  options: BuyTriggerRewardOptions = {},
): PromotionEvaluation {
  const evaluation = emptyEvaluation(promotion);

  const triggerUnits = units.filter(unit =>
    isProductInScope(promotion, unit.productId, unit.categoryIds),
  );

  const minQuantity = Math.max(1, Math.floor(promotion.minQuantity || 1));
  const minCartValue = toToman(promotion.minCartValue);

  // نکته: `units` قبلاً به واحدهای تک‌عددی بسط داده شده‌اند؛ پس هر واحد
  // دقیقاً یک کالا است و `quantity` ردیف نباید دوباره ضرب شود.
  const triggerQuantity = triggerUnits.length;

  const cartValue = units.reduce((sum, unit) => sum + unit.unitPrice, 0);

  if (triggerQuantity < minQuantity) {
    evaluation.reasons.push(
      `حداقل ${minQuantity} کالای محرک برای این پیشنهاد لازم است (اکنون ${triggerQuantity}).`,
    );

    return evaluation;
  }

  if (cartValue < minCartValue) {
    evaluation.reasons.push(
      `حداقل مبلغ سبد برای این پیشنهاد ${minCartValue.toLocaleString('fa-IR')} تومان است.`,
    );

    return evaluation;
  }

  const rewardQuantity = Math.max(1, Math.floor(promotion.rewardQuantity || 1));
  const unitValue =
    options.priceOf?.(
      promotion.suggestedProductId ??
        promotion.rewardProducts?.[0]?.id ??
        0,
      null,
    ) ?? 0;

  const accepted =
    options.rewardAccepted ||
    promotion.autoAddReward ||
    promotion.requiresCustomerAcceptance === false;

  // آیا پاداش در سبد هست؟
  const existingRewardQuantity = (options.existingRewards ?? []).reduce(
    (sum, line) => sum + (line.quantity || 0),
    0,
  );

  const freeItem = (): PromotionFreeItem | null => {
    if (promotion.freeItemSelection === FreeItemSelection.CUSTOMER) {
      if (
        options.selectedReward &&
        (options.selectedReward.productId || options.selectedReward.variantId)
      ) {
        return {
          productId: options.selectedReward.productId,
          variantId: options.selectedReward.variantId,
          quantity: rewardQuantity,
          unitPrice:
            options.priceOf?.(
              options.selectedReward.productId,
              options.selectedReward.variantId,
            ) ?? 0,
        };
      }

      return null;
    }

    const productId =
      promotion.suggestedProductId ??
      promotion.rewardProducts?.[0]?.id ??
      null;

    if (productId == null) {
      return null;
    }

    // اگر ردیف هدیه از قبل در سبد است، قیمت واقعی همان ردیف ملاک است
    const existingLine = options.existingRewards?.find(
      line => line.productId === productId,
    );

    if (existingLine) {
      return {
        productId,
        variantId: existingLine.variantId,
        quantity: rewardQuantity,
        unitPrice: existingLine.unitPrice,
      };
    }

    return {
      productId,
      variantId: null,
      quantity: rewardQuantity,
      unitPrice: options.priceOf?.(productId, null) ?? unitValue,
    };
  };

  const reward = freeItem();

  if (reward && options.isRewardOutOfStock?.(reward.productId, reward.variantId)) {
    evaluation.reasons.push(
      'کالای هدیه در این لحظه موجود نیست؛ به‌جای آن از گزینه‌های دیگر پیشنهاد استفاده کنید.',
    );
    evaluation.message = 'کالای هدیه فعلاً ناموجود است.';

    return evaluation;
  }

  if (reward && options.variantStock) {
    const stock = options.variantStock(
      reward.variantId,
      reward.productId,
    );

    if (stock !== Infinity && stock < reward.quantity) {
      evaluation.reasons.push(
        `از کالای هدیه فقط ${stock} عدد در انبار است.`,
      );

      return evaluation;
    }
  }

  // محدودیت «یک پاداش برای هر سفارش» (maxApplicationsPerCart)
  const maxApplications = Math.max(
    1,
    Math.floor(promotion.maxApplicationsPerCart || 1),
  );
  const rewardCount = Math.min(rewardQuantity, maxApplications);

  if (!accepted) {
    evaluation.reasons.push('پاداش هنوز پذیرفته نشده است.');
    evaluation.requiresAction = true;
    evaluation.message =
      promotion.badgeText?.trim() ||
      promotion.customerDescription?.trim() ||
      'هدیه‌ای برای شما آماده است!';
    // تا وقتی مشتری نپذیرفته، چیزی «رایگان» نشده است؛ ارزش هدیه در سبد و
    // صورت‌حساب نباید کم شود.
    evaluation.freeItemValue = 0;
    evaluation.freeItems = reward
      ? [{ ...reward, quantity: rewardCount }]
      : [];

    return evaluation;
  }

  if (!reward) {
    // اگر خودِ کالای هدیه از قبل در سبد است، همان استفاده می‌شود
    const existing = options.existingRewards?.[0];

    if (existing && existing.variantId != null) {
      const rewardFromCart: PromotionFreeItem = {
        productId: existing.productId,
        variantId: existing.variantId,
        quantity: Math.min(rewardQuantity, Math.max(1, existing.quantity)),
        unitPrice: existing.unitPrice,
      };

      evaluation.qualifies = true;
      evaluation.allocations = [
        {
          lineId: existing.lineId,
          variantId: existing.variantId,
          productId: existing.productId,
          amount: existing.unitPrice * rewardFromCart.quantity,
          discountedUnits: rewardFromCart.quantity,
          isFree: true,
          label: 'رایگان (هدیه پروموشن)',
        },
      ];
      evaluation.freeItems = [rewardFromCart];
      evaluation.freeItemValue = existing.unitPrice * rewardFromCart.quantity;
      evaluation.message =
        promotion.badgeText?.trim() ||
        `${promotion.name}: ${rewardFromCart.quantity} کالای هدیه رایگان شد.`;

      return evaluation;
    }

    evaluation.reasons.push('برای این پیشنهاد باید یک کالای هدیه انتخاب شود.');
    evaluation.requiresAction = true;
    evaluation.message = 'کالای هدیه‌تان را انتخاب کنید.';

    return evaluation;
  }

  const existingLines = options.existingRewards ?? [];
  const rewardLine = existingLines[0];

  const allocations: PromotionDiscountAllocation[] = [];
  const lineId = rewardLine?.lineId ?? `promotion-reward:${promotion.id}`;

  allocations.push({
    lineId,
    variantId: reward.variantId,
    productId: reward.productId,
    amount: (rewardLine?.unitPrice ?? reward.unitPrice) * rewardCount,
    discountedUnits: rewardCount,
    isFree: true,
    label: 'رایگان (هدیه پروموشن)',
  });

  evaluation.qualifies = true;
  evaluation.allocations = mergeAllocations(allocations);
  evaluation.freeItems = [{ ...reward, quantity: rewardCount }];
  evaluation.freeItemValue =
    (rewardLine?.unitPrice ?? reward.unitPrice) * rewardCount;
  evaluation.message =
    promotion.badgeText?.trim() ||
    `${promotion.name}: ${rewardCount} کالای هدیه رایگان شد.`;

  void existingRewardQuantity;

  return evaluation;
}

// =========================================================
// نوع D-1 — Spend & Save
// =========================================================

export function evaluateSpendAndSave(
  promotion: Promotion,
  units: ExpandedUnit[],
): PromotionEvaluation {
  const evaluation = emptyEvaluation(promotion);

  const minCartValue = toToman(promotion.minCartValue);
  const eligible = units.filter(unit =>
    isProductInScope(promotion, unit.productId, unit.categoryIds),
  );

  if (units.length === 0) {
    return evaluation;
  }

  const cartValue = units.reduce((sum, unit) => sum + unit.unitPrice, 0);

  if (cartValue < minCartValue) {
    evaluation.reasons.push(
      `برای فعال شدن این تخفیف حداقل ${minCartValue.toLocaleString('fa-IR')} تومان خرید لازم است؛ ${(minCartValue - cartValue).toLocaleString('fa-IR')} تومان دیگر.`,
    );
    evaluation.message = `${(minCartValue - cartValue).toLocaleString('fa-IR')} تومان دیگر خرید کنید و ${promotion.badgeText || 'تخفیف'} بگیرید.`;

    return evaluation;
  }

  const base = eligible.length ? eligible : units;
  const baseValue = base.reduce((sum, unit) => sum + unit.unitPrice, 0);

  let discount =
    promotion.rewardType === PromotionRewardType.PERCENTAGE
      ? percentOf(baseValue, clampPercent(Number(promotion.rewardValue ?? 0)))
      : toToman(promotion.rewardValue);

  if (promotion.maxDiscountAmount != null) {
    discount = Math.min(discount, toToman(promotion.maxDiscountAmount));
  }

  if (discount <= 0 || baseValue <= 0) {
    return evaluation;
  }

  // پخش متناسب تخفیف روی ردیف‌های مشمول
  const allocations: PromotionDiscountAllocation[] = [];
  const lineTotals = new Map<
    string | number,
    { amount: number; units: number; variantId: number | null; productId: number }
  >();

  for (const unit of base) {
    const key = unit.lineId;
    const current = lineTotals.get(key) ?? {
      amount: 0,
      units: 0,
      variantId: unit.variantId,
      productId: unit.productId,
    };

    current.amount += unit.unitPrice;
    current.units += 1;
    lineTotals.set(key, current);
  }

  let distributed = 0;
  let index = 0;
  const entries = [...lineTotals.entries()];

  for (const [lineId, info] of entries) {
    const isLast = index === entries.length - 1;
    const share = isLast
      ? discount - distributed
      : Math.round((discount * info.amount) / baseValue);

    distributed += share;

    if (share > 0) {
      allocations.push({
        lineId,
        variantId: info.variantId,
        productId: info.productId,
        amount: share,
        discountedUnits: info.units,
        isFree: false,
        label:
          promotion.rewardType === PromotionRewardType.PERCENTAGE
            ? `${clampPercent(Number(promotion.rewardValue ?? 0))}٪ تخفیف پروموشن`
            : 'تخفیف پروموشن',
      });
    }

    index += 1;
  }

  const merged = mergeAllocations(allocations);

  evaluation.qualifies = merged.length > 0;
  evaluation.allocations = merged;
  evaluation.discountAmount = merged.reduce(
    (sum, allocation) => sum + allocation.amount,
    0,
  );
  evaluation.message =
    promotion.badgeText?.trim() || `${evaluation.discountAmount.toLocaleString('fa-IR')} تومان تخفیف خرید.`;

  return evaluation;
}

// =========================================================
// نوع D-2 — خرید X و درصد/مبلغ تخفیف روی اقلام انتخابی
// =========================================================

export function evaluateBuyXGetDiscount(
  promotion: Promotion,
  units: ExpandedUnit[],
): PromotionEvaluation {
  const evaluation = emptyEvaluation(promotion);

  const eligible = units.filter(unit =>
    isProductInScope(promotion, unit.productId, unit.categoryIds),
  );

  const required = Math.max(1, Math.floor(promotion.minQuantity || 1));

  if (eligible.length < required) {
    evaluation.reasons.push(
      `این پیشنهاد با ${required} کالای مشمول فعال می‌شود (اکنون ${eligible.length}).`,
    );
    evaluation.message = `${required - eligible.length} کالای مشمول دیگر اضافه کنید.`;

    return evaluation;
  }

  const percent = clampPercent(Number(promotion.rewardValue ?? 0));
  const fixed = toToman(promotion.rewardValue);
  const allocations: PromotionDiscountAllocation[] = [];

  // همهٔ اقلام مشمولِ بعد از تأمین شرط، تخفیف می‌گیرند (یا فقط یک قلم؟)
  const targets = eligible;

  for (const unit of targets) {
    let amount =
      promotion.rewardType === PromotionRewardType.PERCENTAGE
        ? percentOf(unit.unitPrice, percent)
        : fixed;

    if (promotion.maxDiscountAmount != null) {
      amount = Math.min(amount, toToman(promotion.maxDiscountAmount));
    }

    if (amount <= 0) {
      continue;
    }

    allocations.push({
      lineId: unit.lineId,
      variantId: unit.variantId,
      productId: unit.productId,
      amount,
      discountedUnits: 1,
      isFree: false,
      label:
        promotion.rewardType === PromotionRewardType.PERCENTAGE
          ? `${percent}٪ تخفیف`
          : `${fixed.toLocaleString('fa-IR')} تومان تخفیف`,
    });
  }

  const merged = mergeAllocations(allocations);

  evaluation.qualifies = merged.length > 0;
  evaluation.allocations = merged;
  evaluation.discountAmount = merged.reduce(
    (sum, allocation) => sum + allocation.amount,
    0,
  );
  evaluation.message =
    promotion.badgeText?.trim() ||
    `با خرید ${required} کالای مشمول، تخفیف روی انتخابی‌ها اعمال شد.`;

  return evaluation;
}

// =========================================================
// نوع D-3 — باندل با قیمت ثابت
// =========================================================

/**
 * قیمت ثابت برای «یک ست»؛ اگر تعداد کالاهای مشمول از تعداد ست بیشتر باشد،
 * به تعداد ست‌های کامل، قیمت ثابت اعمال می‌شود.
 */
export function evaluateFixedPriceBundle(
  promotion: Promotion,
  units: ExpandedUnit[],
): PromotionEvaluation {
  const evaluation = emptyEvaluation(promotion);

  const eligible = units.filter(unit =>
    isProductInScope(promotion, unit.productId, unit.categoryIds),
  );

  const bundleSize = Math.max(2, Math.floor(promotion.minQuantity || 2));
  const bundlePrice = toToman(promotion.rewardValue);

  if (bundlePrice <= 0) {
    evaluation.reasons.push('قیمت ثابت باندل تعریف نشده است.');

    return evaluation;
  }

  if (eligible.length < bundleSize) {
    evaluation.reasons.push(
      `باندل با ${bundleSize} کالای مشمول فعال می‌شود (اکنون ${eligible.length}).`,
    );
    evaluation.message = `${bundleSize - eligible.length} کالای مشمول دیگر اضافه کنید تا باندل فعال شود.`;

    return evaluation;
  }

  const bundleCount = Math.min(
    Math.floor(eligible.length / bundleSize),
    Math.max(1, Math.floor(promotion.maxApplicationsPerCart || 1)),
  );

  const ordered = orderDiscountCandidates(eligible);
  const bundleUnits = ordered.slice(0, bundleCount * bundleSize);
  const bundleTotal = bundleUnits.reduce(
    (sum, unit) => sum + unit.unitPrice,
    0,
  );
  const targetPrice = bundlePrice * bundleCount;
  const discount = Math.max(0, bundleTotal - targetPrice);

  if (discount <= 0) {
    evaluation.reasons.push(
      'قیمت فعلی اقلام باندل از قیمت ثابت آن کمتر است؛ نیازی به اعمال نیست.',
    );

    return evaluation;
  }

  const allocations: PromotionDiscountAllocation[] = [];
  let distributed = 0;

  bundleUnits.forEach((unit, index) => {
    const isLast = index === bundleUnits.length - 1;
    const share = isLast
      ? discount - distributed
      : Math.round((discount * unit.unitPrice) / bundleTotal);

    distributed += share;

    if (share > 0) {
      allocations.push({
        lineId: unit.lineId,
        variantId: unit.variantId,
        productId: unit.productId,
        amount: share,
        discountedUnits: 1,
        isFree: false,
        label: `قیمت باندل ${bundlePrice.toLocaleString('fa-IR')} تومانی`,
      });
    }
  });

  const merged = mergeAllocations(allocations);

  evaluation.qualifies = merged.length > 0;
  evaluation.allocations = merged;
  evaluation.discountAmount = merged.reduce(
    (sum, allocation) => sum + allocation.amount,
    0,
  );
  evaluation.message =
    promotion.badgeText?.trim() ||
    `${bundleSize} کالا با قیمت ثابت ${bundlePrice.toLocaleString('fa-IR')} تومان.`;

  return evaluation;
}

// =========================================================
// نوع D-4 — ارسال رایگان
// =========================================================

export function evaluateFreeShipping(
  promotion: Promotion,
  units: ExpandedUnit[],
): PromotionEvaluation {
  const evaluation = emptyEvaluation(promotion);

  const minCartValue = toToman(promotion.minCartValue);
  const eligible = units.filter(unit =>
    isProductInScope(promotion, unit.productId, unit.categoryIds),
  );

  const eligibleValue = eligible.reduce((sum, unit) => sum + unit.unitPrice, 0);

  if (!eligible.length) {
    evaluation.reasons.push('هیچ کالای مشمولی در سبد نیست.');

    return evaluation;
  }

  if (eligibleValue < minCartValue) {
    evaluation.reasons.push(
      `برای ارسال رایگان حداقل ${minCartValue.toLocaleString('fa-IR')} تومان خرید لازم است.`,
    );
    evaluation.message = `${(minCartValue - eligibleValue).toLocaleString('fa-IR')} تومان دیگر تا ارسال رایگان.`;

    return evaluation;
  }

  evaluation.qualifies = true;
  evaluation.grantsFreeShipping = true;
  evaluation.freeItemValue = 0;
  evaluation.message =
    promotion.badgeText?.trim() || 'این سفارش ارسال رایگان دارد.';

  return evaluation;
}

// =========================================================
// نوع D-5 — تخفیف عمومی سبد
// =========================================================

export function evaluateCartDiscount(
  promotion: Promotion,
  units: ExpandedUnit[],
): PromotionEvaluation {
  const evaluation = emptyEvaluation(promotion);

  const minCartValue = toToman(promotion.minCartValue);
  const eligible = units.filter(unit =>
    isProductInScope(promotion, unit.productId, unit.categoryIds),
  );

  if (!eligible.length) {
    evaluation.reasons.push('هیچ کالای مشمولی در سبد نیست.');

    return evaluation;
  }

  const eligibleQuantity = eligible.length;
  const eligibleValue = eligible.reduce((sum, unit) => sum + unit.unitPrice, 0);

  if (promotion.minQuantity > 0 && eligibleQuantity < promotion.minQuantity) {
    evaluation.reasons.push(
      `این تخفیف با ${promotion.minQuantity} کالای مشمول فعال می‌شود.`,
    );

    return evaluation;
  }

  if (eligibleValue < minCartValue) {
    evaluation.reasons.push(
      `حداقل مبلغ این تخفیف ${minCartValue.toLocaleString('fa-IR')} تومان است.`,
    );

    return evaluation;
  }

  let discount =
    promotion.rewardType === PromotionRewardType.PERCENTAGE
      ? percentOf(eligibleValue, clampPercent(Number(promotion.rewardValue ?? 0)))
      : toToman(promotion.rewardValue);

  if (promotion.maxDiscountAmount != null) {
    discount = Math.min(discount, toToman(promotion.maxDiscountAmount));
  }

  if (discount <= 0) {
    return evaluation;
  }

  const allocations: PromotionDiscountAllocation[] = [];
  const lineTotals = new Map<
    string | number,
    { amount: number; units: number; variantId: number | null; productId: number }
  >();

  for (const unit of eligible) {
    const current = lineTotals.get(unit.lineId) ?? {
      amount: 0,
      units: 0,
      variantId: unit.variantId,
      productId: unit.productId,
    };

    current.amount += unit.unitPrice;
    current.units += 1;
    lineTotals.set(unit.lineId, current);
  }

  let distributed = 0;
  const entries = [...lineTotals.entries()];

  entries.forEach(([lineId, info], index) => {
    const isLast = index === entries.length - 1;
    const share = isLast
      ? discount - distributed
      : Math.round((discount * info.amount) / eligibleValue);

    distributed += share;

    if (share > 0) {
      allocations.push({
        lineId,
        variantId: info.variantId,
        productId: info.productId,
        amount: share,
        discountedUnits: info.units,
        isFree: false,
        label: 'تخفیف سبد',
      });
    }
  });

  const merged = mergeAllocations(allocations);

  evaluation.qualifies = merged.length > 0;
  evaluation.allocations = merged;
  evaluation.discountAmount = merged.reduce(
    (sum, allocation) => sum + allocation.amount,
    0,
  );
  evaluation.message =
    promotion.badgeText?.trim() ||
    `${evaluation.discountAmount.toLocaleString('fa-IR')} تومان تخفیف روی سبد.`;

  return evaluation;
}

// =========================================================
// دیسپچ بر اساس نوع
// =========================================================

export interface EvaluateOptions extends BuyTriggerRewardOptions {
  now?: Date;
  /** تعداد استفاده‌های قبلی مشتری و کل (برای محدودیت استفاده) */
  usage?: { total: number; perCustomer: number };
}

export function evaluatePromotion(
  promotion: Promotion,
  units: ExpandedUnit[],
  options: EvaluateOptions = {},
): PromotionEvaluation {
  const now = options.now ?? new Date();
  const state = promotionWindowState(promotion, now);

  if (state !== 'live') {
    const evaluation = emptyEvaluation(promotion, [
      state === 'scheduled'
        ? 'زمان شروع این پروموشن فرا نرسیده است.'
        : state === 'expired'
          ? 'این پروموشن منقضی شده است.'
          : 'این پروموشن غیرفعال است.',
    ]);

    return evaluation;
  }

  if (promotion.maxTotalUses != null) {
    const total = options.usage?.total ?? 0;

    if (total >= promotion.maxTotalUses) {
      return emptyEvaluation(promotion, [
        'ظرفیت کل این پروموشن تکمیل شده است.',
      ]);
    }
  }

  if (promotion.maxUsesPerCustomer != null) {
    const perCustomer = options.usage?.perCustomer ?? 0;

    if (perCustomer >= promotion.maxUsesPerCustomer) {
      return emptyEvaluation(promotion, [
        'شما قبلاً از این پروموشن استفاده کرده‌اید.',
      ]);
    }
  }

  switch (promotion.type) {
    case PromotionType.CHEAPER_ITEM_PAIR:
      return evaluateCheaperItemPair(promotion, units);

    case PromotionType.BUY_X_GET_Y_SAME_GROUP:
      return evaluateBuyXGetY(promotion, units);

    case PromotionType.BUY_TRIGGER_GET_REWARD:
      return evaluateTriggerReward(promotion, units, options);

    case PromotionType.SPEND_AND_SAVE:
      return evaluateSpendAndSave(promotion, units);

    case PromotionType.BUY_X_GET_PERCENT_OFF:
      return evaluateBuyXGetDiscount(promotion, units);

    case PromotionType.FIXED_PRICE_BUNDLE:
      return evaluateFixedPriceBundle(promotion, units);

    case PromotionType.FREE_SHIPPING:
      return evaluateFreeShipping(promotion, units);

    case PromotionType.CART_DISCOUNT:
      return evaluateCartDiscount(promotion, units);

    default: {
      const exhaustive: never = promotion.type;
      return emptyEvaluation(promotion, [
        `نوع پروموشن پشتیبانی نمی‌شود: ${String(exhaustive)}`,
      ]);
    }
  }
}

/** نتیجهٔ خنثی (وقتی ترکیب پروموشن غیرفعال است یا پروموشنی وجود ندارد) */
export const EMPTY_PROMOTION_RESULT: PromotionCartResult = {
  totalDiscount: 0,
  totalFreeItemValue: 0,
  freeShipping: false,
  applied: [],
  rejected: [],
  suggestions: [],
  notices: [],
};
