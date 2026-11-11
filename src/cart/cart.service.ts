// src/carts/carts.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DiscountService } from 'src/discounts/discounts.service';
import { Variant } from 'src/products/entities/variant.entity';
import {
  PromotionCartResult,
  PromotionEvaluation,
  PromotionSuggestion,
} from 'src/promotions/engine/promotion-engine';
import { PromotionsService } from 'src/promotions/promotions.service';
import { Repository } from 'typeorm';

import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { Cart } from './entities/cart.entity';
import { CartItem } from './entities/cart-item.entity';

/** وضعیت تخفیف یک ردیف سبد (فروش ویژه + پروموشن) */
export interface CartItemPromotionState {
  /** تخفیف نقدی پروموشن‌ها برای این ردیف (تومان) */
  promotionDiscount: number;
  /** آیا این ردیف یک کالای رایگان است */
  isFreeReward: boolean;
  /** اگر رایگان است، شناسهٔ پروموشن */
  rewardPromotionId: number | null;
  /** توضیح یک‌خطی برای نمایش روی ردیف */
  labels: string[];
  /** جمع تخفیف پروموشن روی هر واحد */
  promotionDiscountPerUnit: number;
}

interface LinePromotionInfo {
  amount: number;
  isFree: boolean;
  labels: string[];
  promotionIds: number[];
}

@Injectable()
export class CartsService {
  private readonly logger = new Logger(CartsService.name);

  constructor(
    @InjectRepository(Cart)
    private cartRepo: Repository<Cart>,
    @InjectRepository(CartItem)
    private cartItemRepo: Repository<CartItem>,
    @InjectRepository(Variant)
    private variantRepo: Repository<Variant>,

    private readonly discountService: DiscountService,

    private readonly promotionsService: PromotionsService,
  ) {}

  private cartRelations = {
    items: {
      variant: {
        color: true,
        size: true,
        product: {
          categories: true,
        },
      },
    },
  } as const;

  // =========================================================
  // خواندن سبد
  // =========================================================

  /** یافتن یا ایجاد سبد خرید (با userId یا guestId) */
  async getOrCreateCart(userId?: number, guestId?: string): Promise<Cart> {
    return this.findOrCreateCart(userId, guestId, false);
  }

  private async findOrCreateCart(
    userId?: number,
    guestId?: string,
    applyPromotions = true,
  ): Promise<Cart> {
    if (!userId && !guestId) {
      throw new BadRequestException('Either userId or guestId is required');
    }

    const where = userId ? { user: { id: userId } } : { guestId };

    let cart = await this.cartRepo.findOne({
      where,
      relations: this.cartRelations,
    });

    if (!cart) {
      cart = this.cartRepo.create(
        userId ? { user: { id: userId } } : { guestId },
      );

      await this.cartRepo.save(cart);
      cart.items = [];
    }

    if (!applyPromotions) {
      return cart;
    }

    return this.applyPromotionsToCart(cart, userId);
  }

  /** دریافت سبد خرید با قیمت‌گذاری کامل */
  async getCart(userId?: number, guestId?: string): Promise<Cart> {
    if (!userId && !guestId) {
      throw new BadRequestException('Either userId or guestId is required');
    }

    const where = userId ? { user: { id: userId } } : { guestId };

    let cart = await this.cartRepo.findOne({
      where,
      relations: this.cartRelations,
    });

    if (!cart) {
      cart = this.cartRepo.create(
        userId ? { user: { id: userId } } : { guestId },
      );

      await this.cartRepo.save(cart);
      cart.items = [];
    }

    return this.applyPromotionsToCart(cart, userId);
  }

  // =========================================================
  // تغییرات سبد
  // =========================================================

  /** افزودن آیتم به سبد خرید */
  async addToCart(
    userId: number | undefined,
    guestId: string | undefined,
    dto: AddToCartDto,
  ): Promise<Cart> {
    const cart = await this.getOrCreateCart(userId, guestId);

    const variant = await this.variantRepo.findOne({
      where: { id: dto.variantId },
      relations: {
        color: true,
        size: true,
        product: {
          categories: true,
        },
      },
    });

    if (!variant) {
      throw new NotFoundException('واریانت یافت نشد');
    }

    const existingItem = cart.items.find(
      item => item.variant.id === dto.variantId,
    );

    const requestedTotal = (existingItem?.quantity ?? 0) + dto.quantity;

    if (variant.stock < requestedTotal) {
      throw new BadRequestException('موجودی کافی نیست');
    }

    if (existingItem) {
      existingItem.quantity = requestedTotal;
      await this.cartItemRepo.save(existingItem);
    } else {
      const newItem = this.cartItemRepo.create({
        cart,
        variant,
        quantity: dto.quantity,
      });
      await this.cartItemRepo.save(newItem);
    }

    return this.getCart(userId, guestId);
  }

  /** به‌روزرسانی تعداد آیتم */
  async updateItemQuantity(
    userId: number | undefined,
    guestId: string | undefined,
    itemId: number,
    dto: UpdateCartItemDto,
  ): Promise<Cart> {
    const cart = await this.getOrCreateCart(userId, guestId);
    const item = cart.items.find(i => i.id === itemId);

    if (!item) {
      throw new NotFoundException('آیتم در سبد خرید یافت نشد');
    }

    if (dto.quantity <= 0) {
      await this.cartItemRepo.remove(item);
    } else {
      const variant = await this.variantRepo.findOne({
        where: { id: item.variant.id },
      });
      if (!variant) {
        throw new NotFoundException('واریانت یافت نشد');
      }
      if (variant.stock < dto.quantity) {
        throw new BadRequestException('موجودی کافی نیست');
      }
      item.quantity = dto.quantity;
      await this.cartItemRepo.save(item);
    }

    return this.getCart(userId, guestId);
  }

  /** حذف آیتم از سبد خرید */
  async removeItem(
    userId: number | undefined,
    guestId: string | undefined,
    itemId: number,
  ) {
    return this.removeItemDetailed(userId, guestId, itemId, {});
  }

  /**
   * حذف آیتم با پیام شفاف دربارهٔ پاداش‌هایی که با این حذف از بین می‌روند.
   */
  async removeItemDetailed(
    userId: number | undefined,
    guestId: string | undefined,
    itemId: number,
    _options: { force?: boolean } = {},
  ) {
    const cart = await this.getOrCreateCart(userId, guestId);
    const item = cart.items.find(i => i.id === itemId);

    if (!item) {
      throw new NotFoundException('آیتم در سبد خرید یافت نشد');
    }

    const before = await this.promotionsService.evaluateCart({ cart, userId });

    await this.cartItemRepo.remove(item);

    const refreshed = await this.cartRepo.findOne({
      where: { id: cart.id },
      relations: this.cartRelations,
    });

    const after = await this.promotionsService.evaluateCart({
      cart: refreshed ?? { ...cart, items: cart.items.filter(i => i.id !== itemId) },
      userId,
    });

    return {
      cart: await this.getCart(userId, guestId),
      promotionNotices: this.describeUnapplied(before, after),
      lostReward: this.lostRewardLines(before, after),
    };
  }

  /** خالی کردن سبد خرید */
  async clearCart(userId: number, guestId?: string): Promise<void> {
    const cart = await this.getCart(userId, guestId);
    await this.cartItemRepo.delete({ cart: { id: cart.id } });
  }

  /** ادغام سبد مهمان با حساب کاربری */
  async mergeGuestCart(userId: number, guestId: string): Promise<void> {
    const guestCart = await this.cartRepo.findOne({
      where: { guestId },
      relations: {
        items: {
          variant: true,
        },
      },
    });
    if (!guestCart || guestCart.items.length === 0) return;

    let userCart = await this.cartRepo.findOne({
      where: { user: { id: userId } },
      relations: {
        items: {
          variant: true,
        },
      },
    });
    if (!userCart) {
      userCart = this.cartRepo.create({ user: { id: userId } });
      await this.cartRepo.save(userCart);
      userCart.items = [];
    }

    for (const guestItem of guestCart.items) {
      const existing = userCart.items.find(
        item =>
          item.variant.id === guestItem.variant.id &&
          item.promotionRewardId == null &&
          guestItem.promotionRewardId == null,
      );
      if (existing) {
        existing.quantity += guestItem.quantity;
      } else {
        guestItem.cart = userCart;
        userCart.items.push(guestItem);
      }
    }

    // پروموشن‌هایی که مهمان پذیرفته/رد کرده را با سبد کاربر ادغام کن
    const accepted = new Set([
      ...(userCart.acceptedPromotions ?? []),
      ...(guestCart.acceptedPromotions ?? []),
    ]);
    const dismissed = new Set([
      ...(userCart.dismissedPromotions ?? []),
      ...(guestCart.dismissedPromotions ?? []),
    ]);

    userCart.acceptedPromotions = [...accepted];
    userCart.dismissedPromotions = [...dismissed];
    userCart.selectedRewards = [
      ...(userCart.selectedRewards ?? []),
      ...(guestCart.selectedRewards ?? []).filter(
        guest =>
          !(userCart?.selectedRewards ?? []).some(
            own => own.promotionId === guest.promotionId,
          ),
      ),
    ];

    await this.cartRepo.save(userCart);
    await this.cartRepo.remove(guestCart);
  }

  // =========================================================
  // پذیرش/رد پاداش
  // =========================================================

  async acceptPromotion(
    userId: number | undefined,
    guestId: string | undefined,
    promotionId: number,
    accepted = true,
  ) {
    const cart = await this.getOrCreateCart(userId, guestId);
    const current = new Set(cart.acceptedPromotions ?? []);

    if (accepted) {
      current.add(promotionId);
    } else {
      current.delete(promotionId);
    }

    cart.acceptedPromotions = [...current];

    await this.cartRepo.save(cart);

    return this.getCart(userId, guestId);
  }

  async dismissPromotion(
    userId: number | undefined,
    guestId: string | undefined,
    promotionId: number,
  ) {
    const cart = await this.getOrCreateCart(userId, guestId);
    const current = new Set(cart.dismissedPromotions ?? []);

    current.add(promotionId);

    cart.dismissedPromotions = [...current];

    await this.cartRepo.save(cart);

    return this.getCart(userId, guestId);
  }

  async selectReward(
    userId: number | undefined,
    guestId: string | undefined,
    params: { promotionId: number; variantId: number; quantity?: number },
  ) {
    const cart = await this.getOrCreateCart(userId, guestId);

    const variant = await this.variantRepo.findOne({
      where: { id: params.variantId },
      relations: { product: { categories: true }, color: true, size: true },
    });

    if (!variant?.product) {
      throw new NotFoundException('کالای هدیه یافت نشد');
    }

    const reward = await this.promotionsService.addRewardToCart(cart, {
      promotionId: params.promotionId,
      variantId: params.variantId,
      productId: variant.product.id,
      quantity: params.quantity ?? 1,
    });

    const existing = (cart.items ?? []).find(
      item =>
        item.variant?.id === reward.variantId &&
        item.promotionRewardId === params.promotionId,
    );

    if (existing) {
      existing.quantity += reward.quantity;
      await this.cartItemRepo.save(existing);
    } else {
      const item = this.cartItemRepo.create({
        cart,
        variant,
        quantity: reward.quantity,
        promotionRewardId: params.promotionId,
        addedViaPromotion: true,
      });

      await this.cartItemRepo.save(item);
    }

    // انتخاب مشتری برای پروموشن‌های «انتخاب با مشتری» ذخیره شود
    const selected = (cart.selectedRewards ?? []).filter(
      entry => entry.promotionId !== params.promotionId,
    );

    selected.push({
      promotionId: params.promotionId,
      productId: variant.product.id,
      variantId: variant.id,
    });

    cart.selectedRewards = selected;

    const accepted = new Set(cart.acceptedPromotions ?? []);
    accepted.add(params.promotionId);
    cart.acceptedPromotions = [...accepted];

    await this.cartRepo.save(cart);

    return this.getCart(userId, guestId);
  }

  /** افزودن هدیهٔ خودکار/پذیرفته‌شده به سبد (پس از تأیید مشتری) */
  async addRewardToCart(
    userId: number | undefined,
    guestId: string | undefined,
    params: { promotionId: number; variantId?: number; productId?: number; quantity?: number },
  ) {
    const cart = await this.getOrCreateCart(userId, guestId);

    const reward = await this.promotionsService.addRewardToCart(cart, params);

    const variant = await this.variantRepo.findOne({
      where: { id: reward.variantId },
      relations: { color: true, size: true, product: { categories: true } },
    });

    if (!variant) {
      throw new NotFoundException('واریانت هدیه یافت نشد');
    }

    const existing = (cart.items ?? []).find(
      item =>
        item.variant?.id === reward.variantId &&
        item.promotionRewardId === params.promotionId,
    );

    if (existing) {
      existing.quantity += reward.quantity;
      await this.cartItemRepo.save(existing);
    } else {
      const item = this.cartItemRepo.create({
        cart,
        variant,
        quantity: reward.quantity,
        promotionRewardId: params.promotionId,
        addedViaPromotion: true,
      });

      await this.cartItemRepo.save(item);
    }

    const accepted = new Set(cart.acceptedPromotions ?? []);
    accepted.add(params.promotionId);
    cart.acceptedPromotions = [...accepted];

    await this.cartRepo.save(cart);

    return this.getCart(userId, guestId);
  }

  /** حذف هدیهٔ یک پروموشن (مثلاً وقتی مشتری «نه ممنون» می‌زند) */
  async removeReward(
    userId: number | undefined,
    guestId: string | undefined,
    promotionId: number,
  ) {
    const cart = await this.getOrCreateCart(userId, guestId);

    const rewards = (cart.items ?? []).filter(
      item => item.promotionRewardId === promotionId,
    );

    for (const reward of rewards) {
      await this.cartItemRepo.remove(reward);
    }

    const accepted = new Set(cart.acceptedPromotions ?? []);
    accepted.delete(promotionId);
    cart.acceptedPromotions = [...accepted];

    const selected = (cart.selectedRewards ?? []).filter(
      entry => entry.promotionId !== promotionId,
    );
    cart.selectedRewards = selected;

    await this.cartRepo.save(cart);

    return this.getCart(userId, guestId);
  }

  /**
   * همگام‌سازی هدایای سبد با وضعیت پروموشن‌ها:
   * - اگر شرط پروموشن از بین رفته باشد، ردیف هدیه حذف می‌شود
   * - اگر هدیهٔ خودکار اضافه‌نشده باشد و پروموشن خودکار باشد، اضافه می‌شود
   */
  async syncPromotionRewards(cart: Cart, userId?: number) {
    const evaluation = await this.promotionsService.evaluateCart({
      cart,
      userId,
    });

    const rewardLines = (cart.items ?? []).filter(
      item => item.promotionRewardId != null,
    );

    const removed: number[] = [];

    for (const rewardLine of rewardLines) {
      const promotionId = rewardLine.promotionRewardId!;
      const applied = evaluation.applied.find(
        item => item.promotionId === promotionId,
      );

      const stillValid =
        applied &&
        (applied.qualifies || applied.requiresAction) &&
        applied.freeItems.length > 0;

      if (!stillValid) {
        await this.cartItemRepo.remove(rewardLine);
        removed.push(promotionId);
      }
    }

    return { removed, evaluation };
  }

  // =========================================================
  // قیمت‌گذاری
  // =========================================================

  private async applyPromotionsToCart(cart: Cart, userId?: number) {
    let originalPrice = 0;
    let saleDiscountTotal = 0;
    let promotionDiscountTotal = 0;

    const lineInfo = new Map<number, LinePromotionInfo>();

    const salePricedLines: {
      item: CartItem;
      originalPrice: number;
      unitPrice: number;
      saleDiscountPerUnit: number;
    }[] = [];

    for (const item of cart.items ?? []) {
      const variant = item.variant;

      if (!variant?.product) {
        continue;
      }

      const itemOriginalPrice = Number(variant.price);
      const quantity = item.quantity;

      const itemOriginalTotal = itemOriginalPrice * quantity;

      const categoryIds =
        variant.product.categories?.map(category => category.id) ?? [];

      const result = await this.discountService.getBestDiscountForProduct(
        variant.product.id,
        categoryIds,
        itemOriginalPrice,
      );

      let itemDiscountPrice = 0;
      let itemFinalPrice = itemOriginalPrice;

      if (result) {
        itemDiscountPrice = Number(result.discountAmount);
        itemFinalPrice = Number(result.finalPrice);

        (variant as any).discount = {
          id: result.discount.id,
          code: result.discount.code,
          title: result.discount.title,
          type: result.discount.type,
          value: Number(result.discount.value),
          maxDiscountAmount:
            result.discount.maxDiscountAmount != null
              ? Number(result.discount.maxDiscountAmount)
              : null,
          discountAmount: itemDiscountPrice,
        };
      } else {
        (variant as any).discount = null;
      }

      const itemFinalTotal = itemFinalPrice * quantity;
      const itemDiscountTotal = itemDiscountPrice * quantity;

      // برای نمایش قیمت هر محصول
      (variant as any).originalPrice = itemOriginalPrice;
      (variant as any).discountedPrice = itemFinalPrice;

      // جمع کل سبد
      originalPrice += itemOriginalTotal;
      saleDiscountTotal += itemDiscountTotal;

      salePricedLines.push({
        item,
        originalPrice: itemOriginalPrice,
        unitPrice: itemFinalPrice,
        saleDiscountPerUnit: itemDiscountPrice,
      });
    }

    // =====================================================
    // پروموشن‌ها (روی قیمت پس از فروش ویژه)
    // =====================================================

    const promotionCart = this.buildPromotionCart(cart, salePricedLines);

    const promotionResult = await this.promotionsService.evaluateCart({
      cart: promotionCart,
      userId,
    });

    for (const evaluation of promotionResult.applied) {
      for (const allocation of evaluation.allocations) {
        const lineId = Number(allocation.lineId);

        if (!Number.isFinite(lineId)) {
          continue;
        }

        const current = lineInfo.get(lineId) ?? {
          amount: 0,
          isFree: false,
          labels: [],
          promotionIds: [],
        };

        current.amount += allocation.isFree ? 0 : allocation.amount;
        current.isFree = current.isFree || allocation.isFree;

        if (allocation.isFree || allocation.amount > 0) {
          if (!current.labels.includes(allocation.label)) {
            current.labels.push(allocation.label);
          }

          if (!current.promotionIds.includes(evaluation.promotionId)) {
            current.promotionIds.push(evaluation.promotionId);
          }
        }

        lineInfo.set(lineId, current);
      }
    }

    for (const [lineId, info] of lineInfo) {
      promotionDiscountTotal += info.amount;

      const item = (cart.items ?? []).find(entry => entry.id === lineId);

      if (!item) {
        continue;
      }

      const quantity = Math.max(1, item.quantity);
      const perUnit = Math.round(info.amount / quantity);

      const variantState = item.variant as unknown as {
        originalPrice?: number;
        discountedPrice?: number;
      };

      const originalUnit = Number(variantState.originalPrice ?? 0);
      const saleUnit = Number(variantState.discountedPrice ?? 0);

      const promotionState: CartItemPromotionState & {
        promotionIds: number[];
      } = {
        promotionDiscount: info.amount,
        promotionDiscountPerUnit: perUnit,
        isFreeReward: info.isFree,
        rewardPromotionId: info.isFree ? (info.promotionIds[0] ?? null) : null,
        labels: info.labels,
        promotionIds: info.promotionIds,
      };

      (item as any).promotion = promotionState;

      // قیمت قابل پرداخت هر واحد = قیمت پس از فروش ویژه − سهم پروموشن
      const payableUnit = info.isFree
        ? 0
        : Math.max(0, saleUnit - perUnit);

      (item.variant as any).payablePrice = payableUnit;
      (item as any).payableTotal = payableUnit * quantity;

      if (info.isFree) {
        (item as any).freeReason = info.labels.join('، ');
        (item as any).freePromotionId = info.promotionIds[0] ?? null;
      }

      if (originalUnit && saleUnit && payableUnit !== saleUnit) {
        (item.variant as any).originalPrice = originalUnit;
        (item.variant as any).discountedPrice = payableUnit;
      }
    }

    // ردیف‌هایی که تخفیف نگرفتند هم payable بگیرند
    for (const line of salePricedLines) {
      const item = line.item as any;

      if (item.payablePrice == null) {
        item.payablePrice = line.unitPrice;
        item.payableTotal = line.unitPrice * line.item.quantity;
        item.promotion = {
          promotionDiscount: 0,
          promotionDiscountPerUnit: 0,
          isFreeReward: false,
          rewardPromotionId: null,
          labels: [],
          promotionIds: [],
        };
      }
    }

    const finalPrice = Math.max(
      0,
      originalPrice - saleDiscountTotal - promotionDiscountTotal,
    );

    const freeItemValue = promotionResult.totalFreeItemValue;

    const allSuggestions = this.filterDismissedSuggestions(
      promotionCart,
      promotionResult.suggestions,
    );

    return {
      ...cart,

      items: cart.items,

      pricing: {
        originalPrice,
        discountPrice: saleDiscountTotal,
        promotionDiscountPrice: promotionDiscountTotal,
        freeItemValue,
        finalPrice,
        savingsTotal: saleDiscountTotal + promotionDiscountTotal,
        freeShipping: promotionResult.freeShipping,
      },

      promotions: {
        applied: promotionResult.applied.map(evaluation =>
          this.presentEvaluation(evaluation),
        ),
        rejected: promotionResult.rejected.map(evaluation =>
          this.presentEvaluation(evaluation),
        ),
        notices: promotionResult.notices,
        suggestions: allSuggestions,
        /** برای مخفی کردن پاپ‌آپ تا وقتی سبد تغییر نکرده */
        popupState: {
          shownFor: promotionCart.promotionPopupShownFor ?? null,
          dismissed: promotionCart.dismissedPromotions ?? [],
          accepted: promotionCart.acceptedPromotions ?? [],
        },
      },
    } as Cart & Record<string, unknown>;
  }

  private buildPromotionCart(
    cart: Cart,
    salePricedLines: {
      item: CartItem;
      originalPrice: number;
      unitPrice: number;
      saleDiscountPerUnit: number;
    }[],
  ): Cart {
    const clones = salePricedLines.map(line => {
      const clone = Object.create(
        Object.getPrototypeOf(line.item),
      ) as CartItem;

      Object.assign(clone, line.item, {
        variant: {
          ...line.item.variant,
          price: line.unitPrice,
        },
      });

      return clone;
    });

    return Object.assign(Object.create(Object.getPrototypeOf(cart)), cart, {
      items: clones,
    }) as Cart;
  }

  private presentEvaluation(evaluation: PromotionEvaluation) {
    return {
      promotionId: evaluation.promotionId,
      name: evaluation.name,
      type: evaluation.type,
      qualifies: evaluation.qualifies,
      discountAmount: evaluation.discountAmount,
      freeItemValue: evaluation.freeItemValue,
      grantsFreeShipping: evaluation.grantsFreeShipping,
      message: evaluation.message,
      reasons: evaluation.reasons,
      requiresAction: evaluation.requiresAction,
      allocations: evaluation.allocations.map(allocation => ({
        lineId: allocation.lineId,
        amount: allocation.amount,
        isFree: allocation.isFree,
        label: allocation.label,
      })),
      freeItems: evaluation.freeItems,
    };
  }

  /**
   * پاپ‌آپی که ادمین برایش `showPreCartPopup` را روشن کرده و مشتری ردش
   * نکرده است. اگر سبد در جهتی تغییر کند که پیشنهاد «تازه مرتبط» شود،
   * `stateKey` عوض می‌شود و پاپ‌آپ دوباره مجاز است.
   */
  private filterDismissedSuggestions(
    cart: Cart,
    suggestions: PromotionSuggestion[],
  ): PromotionSuggestion[] {
    const dismissed = new Set(cart.dismissedPromotions ?? []);
    const shownFor = cart.promotionPopupShownFor ?? null;

    return suggestions.filter(suggestion => {
      if (dismissed.has(suggestion.promotionId)) {
        return false;
      }

      if (shownFor && shownFor === suggestion.stateKey) {
        return false;
      }

      return true;
    });
  }

  /** ثبت این‌که پاپ‌آپ برای این وضعیت سبد نمایش داده شد */
  async markPopupShown(
    userId: number | undefined,
    guestId: string | undefined,
    stateKey: string,
  ) {
    const cart = await this.getOrCreateCart(userId, guestId);

    cart.promotionPopupShownFor = stateKey;

    await this.cartRepo.save(cart);

    return { success: true, stateKey };
  }

  /** پیام‌های شفاف دربارهٔ پروموشن‌هایی که از یک تغییر سبد حذف شدند */
  private describeUnapplied(
    before: PromotionCartResult,
    after: PromotionCartResult,
  ): string[] {
    const afterIds = new Set(after.applied.map(item => item.promotionId));
    const messages: string[] = [];

    for (const evaluation of before.applied) {
      if (afterIds.has(evaluation.promotionId)) {
        continue;
      }

      const reason = after.rejected
        .find(item => item.promotionId === evaluation.promotionId)
        ?.reasons?.[0];

      messages.push(
        `${evaluation.name} با تغییر سبد حذف شد${reason ? `: ${reason}` : ''}`,
      );
    }

    return messages;
  }

  private lostRewardLines(
    before: PromotionCartResult,
    after: PromotionCartResult,
  ) {
    return before.applied
      .filter(
        item =>
          item.freeItems.length > 0 &&
          !after.applied.some(
            entry => entry.promotionId === item.promotionId,
          ),
      )
      .map(item => ({
        promotionId: item.promotionId,
        name: item.name,
        freeItemValue: item.freeItemValue,
      }));
  }
}
