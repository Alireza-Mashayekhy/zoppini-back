import { FreeItemSelection, Promotion, PromotionRewardType, PromotionType } from '../entities/promotion.entity';
import {
  EvaluateOptions,
  evaluatePromotion,
  ExpandedUnit,
  isProductInScope,
  isPromotionLive,
  orderDiscountCandidates,
  PromotionCartLine,
  PromotionCartResult,
  PromotionEvaluation,
  PromotionSuggestion,
  toToman,
} from './promotion-engine';

/**
 * هماهنگ‌کنندهٔ پروموشن‌ها: تصمیم می‌گیرد کدام پروموشن‌ها اعمال شوند،
 * با هم ترکیب شوند یا کنار گذاشته شوند و چه پیشنهادی به مشتری نشان داده شود.
 *
 * قواعد:
 * ۱. اگر ترکیب مجاز باشد، پروموشن‌های `canStack` همه اعمال می‌شوند و از
 *    بین پروموشن‌های غیرترکیب‌پذیر فقط بهترین (بیشترین صرفه) اضافه می‌شود.
 * ۲. اگر ترکیب غیرفعال باشد، فقط بهترین پروموشن اعمال می‌شود.
 * ۳. تخفیف دوبار روی یک ردیف/واحد اعمال نمی‌شود؛ مجموع تخفیف هر ردیف از
 *    ارزش آن ردیف بیشتر نمی‌شود (dedupeWithLineBudget).
 * ۴. کالای رایگانِ یک پروموشن، محرک پروموشن دیگر نمی‌شود.
 */
export interface CoordinatorInput {
  promotions: Promotion[];
  lines: PromotionCartLine[];
  options?: EvaluateOptions & {
    acceptedRewards?: Record<number, boolean>;
    selectedRewards?: Record<
      number,
      { productId: number; variantId: number | null }
    >;
    /** تعداد استفاده‌های قبلی هر پروموشن */
    usageByPromotion?: Record<number, { total: number; perCustomer: number }>;
    /** پیش‌فرض true */
    allowStacking?: boolean;
    now?: Date;
  };
}

export function expandPromotionUnits(
  lines: PromotionCartLine[],
): ExpandedUnit[] {
  const units: ExpandedUnit[] = [];

  for (const line of lines) {
    if (line.isFreeReward) {
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

function expiredReason(promotion: Promotion, now: Date): string {
  if (!promotion.isActive) {
    return 'این پروموشن غیرفعال شده است.';
  }

  if (new Date(promotion.startsAt).getTime() > now.getTime()) {
    return 'زمان شروع این پروموشن فرا نرسیده است.';
  }

  if (new Date(promotion.expiresAt).getTime() < now.getTime()) {
    return 'این پروموشن منقضی شده است.';
  }

  return 'پروموشن در این بازهٔ زمانی فعال نیست.';
}

function evaluationValue(evaluation: PromotionEvaluation): number {
  return evaluation.discountAmount + evaluation.freeItemValue;
}

function withPromotion(promotion: Promotion): (e: PromotionEvaluation) => PromotionEvaluation {
  return evaluation => ({
    ...evaluation,
    promotionId: promotion.id,
    type: promotion.type,
    canStack: promotion.canStack,
    autoAddReward: promotion.autoAddReward,
    allocations: evaluation.allocations.map(allocation => ({
      ...allocation,
      promotionId: promotion.id,
    })),
  });
}

/**
 * سقف تخفیف هر ردیف = ارزش آن ردیف؛ تخفیف مازاد (که یعنی همان واحد/ردیف
 * دوبار تخفیف خورده) حذف می‌شود.
 */
function applyLineBudget(
  evaluations: PromotionEvaluation[],
  lines: PromotionCartLine[],
): PromotionEvaluation[] {
  const lineValue = new Map<string, number>();

  for (const line of lines) {
    // ردیف‌های رایگان هم بودجهٔ خودشان را دارند (کل ارزش ردیف)
    const key = String(line.lineId);
    lineValue.set(
      key,
      (lineValue.get(key) ?? 0) +
        toToman(line.unitPrice) * Math.max(0, line.quantity || 0),
    );
  }

  return evaluations.map(evaluation => {
    let changed = false;

    const allocations = evaluation.allocations
      .map(allocation => {
        const key = String(allocation.lineId);
        const budget = lineValue.get(key);

        if (budget == null) {
          // ردیف مجازی (پاداش تازه) — بودجه‌اش همان مبلغ اعلامی است
          return allocation;
        }

        if (allocation.isFree) {
          // ردیف رایگان: کل ارزش ردیف آزاد است و با تخفیف نقدی رقابت نمی‌کند
          return allocation;
        }

        if (allocation.amount <= budget) {
          return allocation;
        }

        changed = true;

        return { ...allocation, amount: budget };
      })
      .filter(allocation => allocation.amount > 0 || allocation.isFree);

    if (!changed) {
      return evaluation;
    }

    const discountAmount = allocations
      .filter(allocation => !allocation.isFree)
      .reduce((sum, allocation) => sum + allocation.amount, 0);

    return { ...evaluation, allocations, discountAmount };
  });
}

/**
 * اعمال هم‌زمان پرداخت چند پروموشن روی یک ردیف: تخفیف‌ها به‌ترتیب ارزش
 * کم‌شونده پرداخت می‌شوند تا جمعشان از ارزش ردیف بیشتر نشود. تخفیفی که
 * باقیماندهٔ بودجه را دارد کوچک می‌شود (نه حذف کامل).
 */
function applyCumulativeLineBudget(
  evaluations: PromotionEvaluation[],
  lines: PromotionCartLine[],
): PromotionEvaluation[] {
  const remaining = new Map<string, number>();

  for (const line of lines) {
    const key = String(line.lineId);
    remaining.set(
      key,
      (remaining.get(key) ?? 0) +
        toToman(line.unitPrice) * Math.max(0, line.quantity || 0),
    );
  }

  return evaluations.map(evaluation => {
    let changed = false;

    const allocations = evaluation.allocations.map(allocation => {
      const key = String(allocation.lineId);
      const budget = remaining.get(key);

      if (allocation.isFree) {
        return allocation;
      }

      if (budget == null) {
        return allocation;
      }

      if (allocation.amount <= budget) {
        remaining.set(key, budget - allocation.amount);

        return allocation;
      }

      changed = true;
      remaining.set(key, 0);

      return { ...allocation, amount: Math.max(0, budget) };
    });

    if (!changed) {
      return evaluation;
    }

    const merged = allocations.filter(
      allocation => allocation.amount > 0 || allocation.isFree,
    );

    const discountAmount = merged
      .filter(allocation => !allocation.isFree)
      .reduce((sum, allocation) => sum + allocation.amount, 0);

    const freeItemValue = merged
      .filter(allocation => allocation.isFree)
      .reduce((sum, allocation) => sum + allocation.amount, 0);

    return {
      ...evaluation,
      allocations: merged,
      discountAmount,
      freeItemValue,
    };
  });
}

export function coordinatePromotions(
  input: CoordinatorInput,
): PromotionCartResult {
  const now = input.options?.now ?? new Date();
  const allowStacking = input.options?.allowStacking ?? true;
  const acceptedRewards = input.options?.acceptedRewards ?? {};
  const selectedRewards = input.options?.selectedRewards ?? {};

  const units = expandPromotionUnits(input.lines);
  const freeRewardLines = input.lines.filter(line => line.isFreeReward);

  const live: { promotion: Promotion; evaluation: PromotionEvaluation }[] = [];
  const dead: PromotionEvaluation[] = [];

  for (const promotion of input.promotions) {
    if (!isPromotionLive(promotion, now)) {
      dead.push(
        withPromotion(promotion)({
          promotionId: promotion.id,
          name: promotion.name,
          type: promotion.type,
          qualifies: false,
          discountAmount: 0,
          freeItemValue: 0,
          grantsFreeShipping: false,
          allocations: [],
          freeItems: [],
          reasons: [expiredReason(promotion, now)],
          message: null,
          requiresAction: false,
          autoAddReward: promotion.autoAddReward,
          canStack: promotion.canStack,
        }),
      );

      continue;
    }

    const existingRewards = freeRewardLines.filter(
      line => line.rewardPromotionId === promotion.id,
    );

    const accepted =
      acceptedRewards[promotion.id] ??
      (promotion.autoAddReward || !promotion.requiresCustomerAcceptance);

    const evaluation = evaluatePromotion(promotion, units, {
      ...input.options,
      now,
      rewardAccepted: accepted,
      selectedReward: selectedRewards[promotion.id] ?? null,
      existingRewards,
      usage: input.options?.usageByPromotion?.[promotion.id],
    });

    live.push({ promotion, evaluation: withPromotion(promotion)(evaluation) });
  }

  const qualifying = live.filter(item => item.evaluation.qualifies);
  // پاداش‌هایی که منتظر تأیید مشتری هستند هم باید دیده شوند (بدون تخفیف نقدی)
  const pending = live.filter(
    item => !item.evaluation.qualifies && item.evaluation.requiresAction,
  );
  const stackable = qualifying.filter(item => item.promotion.canStack);
  const solo = qualifying
    .filter(item => !item.promotion.canStack)
    .sort(
      (a, b) =>
        evaluationValue(b.evaluation) - evaluationValue(a.evaluation) ||
        (b.promotion.priority ?? 0) - (a.promotion.priority ?? 0) ||
        a.promotion.id - b.promotion.id,
    );

  let chosen: { promotion: Promotion; evaluation: PromotionEvaluation }[] = [];

  if (allowStacking) {
    chosen = [...stackable, ...solo.slice(0, 1), ...pending];
  } else {
    chosen = [...stackable, ...solo]
      .sort(
        (a, b) =>
          evaluationValue(b.evaluation) - evaluationValue(a.evaluation) ||
          (b.promotion.priority ?? 0) - (a.promotion.priority ?? 0) ||
          a.promotion.id - b.promotion.id,
      )
      .slice(0, 1);

    chosen = [...chosen, ...pending];
  }

  const chosenIds = new Set(chosen.map(item => item.promotion.id));

  const rejected: PromotionEvaluation[] = [
    ...dead,
    ...live
      .filter(
        item =>
          !item.evaluation.qualifies &&
          !pending.some(entry => entry.promotion.id === item.promotion.id),
      )
      .map(item => item.evaluation),
    ...(allowStacking
      ? solo
          .filter(item => !chosenIds.has(item.promotion.id))
          .map(item => ({
            ...item.evaluation,
            qualifies: false,
            reasons: [
              ...item.evaluation.reasons,
              'این پروموشن با پروموشنی که اعمال شد قابل ترکیب نیست.',
            ],
          }))
      : [...stackable, ...solo]
          .filter(item => !chosenIds.has(item.promotion.id))
          .map(item => ({
            ...item.evaluation,
            qualifies: false,
            reasons: [
              ...item.evaluation.reasons,
              'ترکیب پروموشن‌ها غیرفعال است؛ فقط بهترین پیشنهاد اعمال می‌شود.',
            ],
          }))),
  ];

  const applied = applyCumulativeLineBudget(
    chosen.map(item => item.evaluation),
    input.lines,
  );

  // پس از سقف‌گذاری ممکن است پروموشنی کاملاً صفر شود
  const visible = applied.filter(
    evaluation =>
      evaluation.discountAmount > 0 ||
      evaluation.freeItemValue > 0 ||
      evaluation.grantsFreeShipping ||
      evaluation.requiresAction ||
      evaluation.qualifies,
  );

  const totalDiscount = visible.reduce(
    (sum, evaluation) =>
      sum +
      evaluation.allocations
        .filter(allocation => !allocation.isFree)
        .reduce((lineSum, allocation) => lineSum + allocation.amount, 0),
    0,
  );

  const totalFreeItemValue = visible.reduce(
    (sum, evaluation) =>
      sum +
      evaluation.allocations
        .filter(allocation => allocation.isFree)
        .reduce((lineSum, allocation) => lineSum + allocation.amount, 0),
    0,
  );

  const freeShipping = visible.some(evaluation => evaluation.grantsFreeShipping);

  const notices: string[] = [];

  for (const evaluation of rejected) {
    const first = evaluation.reasons[0];

    if (!first) {
      continue;
    }

    if (
      first.includes('منقضی') ||
      first.includes('غیرفعال') ||
      first.includes('تکمیل شده') ||
      first.includes('استفاده کرده‌اید') ||
      first.includes('محرک')
    ) {
      notices.push(`${evaluation.name}: ${first}`);
    }
  }

  // اگر پاداشی از قبل در سبد بود و شرطش از بین رفته، فعالانه اعلان بده
  for (const rewardLine of freeRewardLines) {
    const stillApplied = visible.some(
      evaluation =>
        evaluation.qualifies &&
        evaluation.promotionId === rewardLine.rewardPromotionId,
    );

    if (!stillApplied) {
      const promotion = input.promotions.find(
        item => item.id === rewardLine.rewardPromotionId,
      );

      const notice = `${promotion?.name ?? 'پیشنهاد ویژه'}: کالای محرک این هدیه از سبد حذف شده است؛ هدیهٔ رایگان حذف می‌شود.`;

      if (!notices.includes(notice)) {
        notices.push(notice);
      }
    }
  }

  return {
    totalDiscount,
    totalFreeItemValue,
    freeShipping,
    applied: visible,
    rejected,
    suggestions: buildSuggestions(input.promotions, units, freeRewardLines, {
      acceptedRewards,
      selectedRewards,
      now,
    }),
    notices,
  };
}

interface SuggestionContext {
  acceptedRewards: Record<number, boolean>;
  selectedRewards: Record<
    number,
    { productId: number; variantId: number | null }
  >;
  now: Date;
}

/**
 * پیشنهاد پیش از سبد: پروموشن‌هایی که با «افزودن یک کالا» کامل می‌شوند.
 * فقط پروموشن‌هایی که ادمین برایشان `showPreCartPopup` را روشن کرده است.
 */
export function buildSuggestions(
  promotions: Promotion[],
  units: ExpandedUnit[],
  freeRewardLines: PromotionCartLine[],
  context: SuggestionContext,
): PromotionSuggestion[] {
  const suggestions: PromotionSuggestion[] = [];
  const cartQuantity = units.length;

  for (const promotion of promotions) {
    if (!promotion.showPreCartPopup) {
      continue;
    }

    if (!isPromotionLive(promotion, context.now)) {
      continue;
    }

    if (cartQuantity === 0) {
      continue;
    }

    const existingRewards = freeRewardLines.filter(
      line => line.rewardPromotionId === promotion.id,
    );

    const evaluation = evaluatePromotion(promotion, units, {
      now: context.now,
      rewardAccepted:
        context.acceptedRewards[promotion.id] ??
        (promotion.autoAddReward || !promotion.requiresCustomerAcceptance),
      selectedReward: context.selectedRewards[promotion.id] ?? null,
      existingRewards,
    });

    // اگر همین حالا پاداش کامل است و کالای رایگان در سبد هست، پیشنهاد لازم نیست
    if (evaluation.qualifies && existingRewards.length > 0) {
      continue;
    }

    const suggestion = suggestionFor(promotion, units, evaluation);

    if (suggestion) {
      suggestions.push(suggestion);
    }
  }

  return suggestions;
}

function suggestionFor(
  promotion: Promotion,
  units: ExpandedUnit[],
  evaluation: PromotionEvaluation,
): PromotionSuggestion | null {
  const hint = evaluation.message?.trim() || promotion.customerDescription;
  const requiresSelection =
    promotion.freeItemSelection === FreeItemSelection.CUSTOMER;

  const suggestedProductId =
    promotion.popupSuggestedProductId ?? promotion.suggestedProductId ?? null;
  const suggestedCategoryId =
    promotion.popupSuggestedCategoryId ?? promotion.suggestedCategoryId ?? null;

  switch (promotion.type) {
    case PromotionType.BUY_X_GET_Y_SAME_GROUP: {
      const eligible = units.filter(unit =>
        isProductInScope(promotion, unit.productId, unit.categoryIds),
      );

      if (!eligible.length) {
        return null;
      }

      const nearest = orderDiscountCandidates(eligible)[0];
      const missing =
        promotion.requiredQuantity +
        promotion.freeQuantity -
        eligible.length;

      return {
        promotionId: promotion.id,
        title: promotion.popupTitle?.trim() || promotion.name,
        description: promotion.popupDescription ?? hint,
        badgeText: promotion.badgeText,
        hint:
          hint ??
          `${missing} کالای مشمول دیگر اضافه کنید و ${promotion.freeQuantity} کالا رایگان بگیرید.`,
        suggestedProduct: nearest
          ? {
              productId: nearest.productId,
              variantId: nearest.variantId,
              price: nearest.unitPrice,
            }
          : suggestedProductId
            ? { productId: suggestedProductId, variantId: null }
            : null,
        suggestedCategoryId,
        acceptLabel: promotion.popupAcceptLabel,
        dismissLabel: promotion.popupDismissLabel,
        rewardIsFree: true,
        requiresSelection: false,
        // برای کامل شدن X، مشتری باید یک کالای «مشمول و پولی» اضافه کند
        action: 'add_paid_item',
        stateKey: `${promotion.id}:${eligible.length}:${promotion.freeQuantity}`,
      };
    }

    case PromotionType.BUY_TRIGGER_GET_REWARD: {
      const triggerUnits = units.filter(unit =>
        isProductInScope(promotion, unit.productId, unit.categoryIds),
      );

      if (!triggerUnits.length) {
        return null;
      }

      const nearest = orderDiscountCandidates(triggerUnits)[0];
      const missing = Math.max(
        0,
        Math.max(1, promotion.minQuantity || 1) - triggerUnits.length,
      );

      return {
        promotionId: promotion.id,
        title: promotion.popupTitle?.trim() || promotion.name,
        description: promotion.popupDescription ?? hint,
        badgeText: promotion.badgeText,
        hint:
          hint ??
          (missing > 0
            ? `${missing} کالای محرک دیگر لازم است.`
            : 'کالای هدیه را به سبد اضافه کنید و رایگان دریافت کنید.'),
        suggestedProduct: suggestedProductId
          ? { productId: suggestedProductId, variantId: null }
          : nearest
            ? {
                productId: nearest.productId,
                variantId: nearest.variantId,
                price: nearest.unitPrice,
              }
            : null,
        suggestedCategoryId,
        acceptLabel: promotion.popupAcceptLabel,
        dismissLabel: promotion.popupDismissLabel,
        rewardIsFree: true,
        requiresSelection,
        /*
         * اگر هنوز کالای محرک کم است، افزودن کالای پیشنهادی «پولی» است و
         * نباید از مسیر پاداش رایگان اضافه شود؛ وقتی شرط کامل است، دکمه
         * هدیهٔ رایگان را اضافه می‌کند.
         */
        action: missing > 0 ? 'add_paid_item' : 'add_free_reward',
        stateKey: `${promotion.id}:${triggerUnits.length}:${promotion.rewardQuantity}`,
      };
    }

    case PromotionType.SPEND_AND_SAVE:
    case PromotionType.FREE_SHIPPING:
    case PromotionType.CART_DISCOUNT: {
      if (!suggestedProductId && !suggestedCategoryId) {
        return null;
      }

      return {
        promotionId: promotion.id,
        title: promotion.popupTitle?.trim() || promotion.name,
        description: promotion.popupDescription ?? hint,
        badgeText: promotion.badgeText,
        hint:
          hint ??
          `${(
            toToman(promotion.minCartValue) -
            units.reduce((sum, unit) => sum + unit.unitPrice, 0)
          ).toLocaleString('fa-IR')} تومان دیگر تا فعال شدن این پیشنهاد.`,
        suggestedProduct: suggestedProductId
          ? { productId: suggestedProductId, variantId: null }
          : null,
        suggestedCategoryId,
        acceptLabel: promotion.popupAcceptLabel,
        dismissLabel: promotion.popupDismissLabel,
        rewardIsFree:
          promotion.rewardType === PromotionRewardType.FREE_ITEM ||
          promotion.type === PromotionType.FREE_SHIPPING,
        requiresSelection: false,
        /*
         * این پیشنهادها با «خرید بیشتر» کامل می‌شوند؛ افزودن کالای پولی از
         * یک پاپ‌آپ می‌تواند ناخواسته باشد، پس فقط راهنمایی می‌کنیم.
         */
        action: 'open_cart',
        stateKey: `${promotion.id}:${units.length}`,
      };
    }

    default:
      return null;
  }
}
