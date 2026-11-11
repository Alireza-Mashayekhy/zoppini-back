import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cart } from 'src/cart/entities/cart.entity';
import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import { Variant } from 'src/products/entities/variant.entity';
import { In, Repository } from 'typeorm';

import {
  CreatePromotionDto,
  PreviewPromotionDto,
  UpdatePromotionDto,
} from './dto/promotion.dto';
import {
  coordinatePromotions,
  expandPromotionUnits,
} from './engine/promotion-coordinator';
import {
  isPromotionLive,
  promotionWindowState,
  PromotionCartLine,
  PromotionCartResult,
  PromotionEvaluation,
  PromotionSuggestion,
  isProductInRewardScope,
  isProductInScope,
} from './engine/promotion-engine';
import {
  FreeItemSelection,
  Promotion,
  PromotionRewardType,
  PromotionScope,
  PromotionType,
} from './entities/promotion.entity';
import {
  PromotionEvent,
  PromotionEventKind,
  PromotionRedemption,
} from './entities/promotion-redemption.entity';
import { PreparedPromotion, PromotionsRepository } from './promotions.repository';

export interface PromotionCartContext {
  cart: Cart;
  userId?: number;
  guestId?: string;
  /** آیا این ارزیابی برای ثبت سفارش است (سخت‌گیرانه) */
  forCheckout?: boolean;
  now?: Date;
}

@Injectable()
export class PromotionsService {
  private readonly logger = new Logger(PromotionsService.name);

  constructor(
    @InjectRepository(Promotion)
    private readonly promotionRepo: Repository<Promotion>,

    @InjectRepository(PromotionRedemption)
    private readonly redemptionRepo: Repository<PromotionRedemption>,

    @InjectRepository(PromotionEvent)
    private readonly eventRepo: Repository<PromotionEvent>,

    @InjectRepository(Cart)
    private readonly cartRepo: Repository<Cart>,

    private readonly promotionsRepository: PromotionsRepository,
  ) {}

  // =========================================================
  // ADMIN CRUD
  // =========================================================

  async findAll(query: {
    search?: string;
    type?: PromotionType;
    status?: string;
  }) {
    const qb = this.promotionRepo
      .createQueryBuilder('promotion')
      .leftJoinAndSelect('promotion.products', 'product')
      .leftJoinAndSelect('promotion.categories', 'category')
      .leftJoinAndSelect('promotion.excludedProducts', 'excludedProduct')
      .leftJoinAndSelect('promotion.excludedCategories', 'excludedCategory')
      .leftJoinAndSelect('promotion.rewardProducts', 'rewardProduct')
      .leftJoinAndSelect('promotion.rewardCategories', 'rewardCategory');

    if (query.search?.trim()) {
      qb.andWhere(
        '(promotion.name LIKE :search OR promotion.internalDescription LIKE :search)',
        { search: `%${query.search.trim()}%` },
      );
    }

    if (query.type) {
      qb.andWhere('promotion.type = :type', { type: query.type });
    }

    const now = new Date();

    switch (query.status) {
      case 'live':
        qb.andWhere('promotion.isActive = :active', { active: true })
          .andWhere('promotion.startsAt <= :now', { now })
          .andWhere('promotion.expiresAt >= :now', { now });
        break;

      case 'scheduled':
        qb.andWhere('promotion.isActive = :active', { active: true }).andWhere(
          'promotion.startsAt > :now',
          { now },
        );
        break;

      case 'expired':
        qb.andWhere('promotion.expiresAt < :now', { now });
        break;

      case 'inactive':
        qb.andWhere('promotion.isActive = :active', { active: false });
        break;

      default:
        break;
    }

    qb.orderBy('promotion.createdAt', 'DESC').addOrderBy('promotion.id', 'DESC');

    const data = await qb.getMany();
    const usage = await this.countUsageFor(data.map(item => item.id));

    return {
      data: data.map(promotion =>
        this.present(promotion, now, usage.get(promotion.id)),
      ),
      total: data.length,
    };
  }

  async findOne(id: number) {
    const promotion = await this.promotionRepo.findOne({
      where: { id },
      relations: {
        products: true,
        categories: true,
        excludedProducts: true,
        excludedCategories: true,
        rewardProducts: true,
        rewardCategories: true,
        suggestedProduct: true,
        suggestedCategory: true,
        popupSuggestedProduct: true,
        popupSuggestedCategory: true,
      },
    });

    if (!promotion) {
      throw new NotFoundException('پروموشن یافت نشد.');
    }

    const usage = await this.countUsageFor([promotion.id]);

    return { data: this.present(promotion, new Date(), usage.get(promotion.id)) };
  }

  async create(dto: CreatePromotionDto) {
    this.assertConfiguration(dto);

    const promotion = this.promotionRepo.create({
      name: dto.name.trim(),
      internalDescription: dto.internalDescription ?? null,
      type: dto.type,
      scope: dto.scope ?? PromotionScope.ALL,
      rewardType: dto.rewardType,
      rewardValue: dto.rewardValue ?? null,
      maxDiscountAmount: dto.maxDiscountAmount ?? null,
      minQuantity: dto.minQuantity ?? 0,
      minCartValue: dto.minCartValue ?? 0,
      pairSize: dto.pairSize ?? 2,
      discountEveryExtraUnit: dto.discountEveryExtraUnit ?? false,
      requiredQuantity: dto.requiredQuantity ?? 0,
      freeQuantity: dto.freeQuantity ?? 0,
      rewardScope: dto.rewardScope ?? null,
      suggestedProductId: dto.suggestedProductId ?? null,
      suggestedCategoryId: dto.suggestedCategoryId ?? null,
      rewardQuantity: dto.rewardQuantity ?? 1,
      freeItemSelection: dto.freeItemSelection ?? FreeItemSelection.AUTO,
      autoAddReward: dto.autoAddReward ?? false,
      requiresCustomerAcceptance: dto.requiresCustomerAcceptance ?? true,
      removeRewardWhenTriggerRemoved:
        dto.removeRewardWhenTriggerRemoved ?? true,
      isActive: dto.isActive ?? true,
      startsAt: new Date(dto.startsAt),
      expiresAt: new Date(dto.expiresAt),
      maxTotalUses: dto.maxTotalUses ?? null,
      maxUsesPerCustomer: dto.maxUsesPerCustomer ?? null,
      maxApplicationsPerCart: dto.maxApplicationsPerCart ?? 1,
      canStack: dto.canStack ?? false,
      stackable: dto.stackable ?? dto.canStack ?? false,
      priority: dto.priority ?? 0,
      badgeText: dto.badgeText ?? null,
      customerDescription: dto.customerDescription ?? null,
      showBadgeOnProductCard: dto.showBadgeOnProductCard ?? false,
      showBadgeOnProductPage: dto.showBadgeOnProductPage ?? false,
      showPreCartPopup: dto.showPreCartPopup ?? false,
      popupTitle: dto.popupTitle ?? null,
      popupDescription: dto.popupDescription ?? null,
      popupAcceptLabel: dto.popupAcceptLabel ?? null,
      popupDismissLabel: dto.popupDismissLabel ?? null,
      popupSuggestedProductId: dto.popupSuggestedProductId ?? null,
      popupSuggestedCategoryId: dto.popupSuggestedCategoryId ?? null,
    });

    await this.applyRelations(promotion, dto);

    const saved = await this.saveAndReload(promotion);

    this.promotionsRepository.invalidateCache();

    return { data: this.present(saved, new Date()) };
  }

  async update(id: number, dto: UpdatePromotionDto) {
    const promotion = await this.promotionRepo.findOne({
      where: { id },
      relations: {
        products: true,
        categories: true,
        excludedProducts: true,
        excludedCategories: true,
        rewardProducts: true,
        rewardCategories: true,
      },
    });

    if (!promotion) {
      throw new NotFoundException('پروموشن یافت نشد.');
    }

    const merged: CreatePromotionDto = {
      name: dto.name ?? promotion.name,
      type: dto.type ?? promotion.type,
      scope: dto.scope ?? promotion.scope,
      rewardType: dto.rewardType ?? promotion.rewardType,
      rewardValue:
        dto.rewardValue !== undefined
          ? dto.rewardValue
          : promotion.rewardValue == null
            ? null
            : Number(promotion.rewardValue),
      startsAt: dto.startsAt ?? promotion.startsAt.toISOString(),
      expiresAt: dto.expiresAt ?? promotion.expiresAt.toISOString(),
      minCartValue:
        dto.minCartValue !== undefined
          ? dto.minCartValue
          : Number(promotion.minCartValue),
      minQuantity: dto.minQuantity ?? promotion.minQuantity,
      pairSize: dto.pairSize ?? promotion.pairSize,
      requiredQuantity: dto.requiredQuantity ?? promotion.requiredQuantity,
      freeQuantity: dto.freeQuantity ?? promotion.freeQuantity,
    };

    this.assertConfiguration(merged);

    Object.assign(promotion, {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.internalDescription !== undefined
        ? { internalDescription: dto.internalDescription }
        : {}),
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.scope !== undefined ? { scope: dto.scope } : {}),
      ...(dto.rewardType !== undefined ? { rewardType: dto.rewardType } : {}),
      ...(dto.rewardValue !== undefined ? { rewardValue: dto.rewardValue } : {}),
      ...(dto.maxDiscountAmount !== undefined
        ? { maxDiscountAmount: dto.maxDiscountAmount }
        : {}),
      ...(dto.minQuantity !== undefined ? { minQuantity: dto.minQuantity } : {}),
      ...(dto.minCartValue !== undefined
        ? { minCartValue: dto.minCartValue }
        : {}),
      ...(dto.pairSize !== undefined ? { pairSize: dto.pairSize } : {}),
      ...(dto.discountEveryExtraUnit !== undefined
        ? { discountEveryExtraUnit: dto.discountEveryExtraUnit }
        : {}),
      ...(dto.requiredQuantity !== undefined
        ? { requiredQuantity: dto.requiredQuantity }
        : {}),
      ...(dto.freeQuantity !== undefined
        ? { freeQuantity: dto.freeQuantity }
        : {}),
      ...(dto.rewardScope !== undefined
        ? { rewardScope: dto.rewardScope }
        : {}),
      ...(dto.suggestedProductId !== undefined
        ? { suggestedProductId: dto.suggestedProductId }
        : {}),
      ...(dto.suggestedCategoryId !== undefined
        ? { suggestedCategoryId: dto.suggestedCategoryId }
        : {}),
      ...(dto.rewardQuantity !== undefined
        ? { rewardQuantity: dto.rewardQuantity }
        : {}),
      ...(dto.freeItemSelection !== undefined
        ? { freeItemSelection: dto.freeItemSelection }
        : {}),
      ...(dto.autoAddReward !== undefined
        ? { autoAddReward: dto.autoAddReward }
        : {}),
      ...(dto.requiresCustomerAcceptance !== undefined
        ? { requiresCustomerAcceptance: dto.requiresCustomerAcceptance }
        : {}),
      ...(dto.removeRewardWhenTriggerRemoved !== undefined
        ? { removeRewardWhenTriggerRemoved: dto.removeRewardWhenTriggerRemoved }
        : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.startsAt !== undefined ? { startsAt: new Date(dto.startsAt) } : {}),
      ...(dto.expiresAt !== undefined
        ? { expiresAt: new Date(dto.expiresAt) }
        : {}),
      ...(dto.maxTotalUses !== undefined
        ? { maxTotalUses: dto.maxTotalUses }
        : {}),
      ...(dto.maxUsesPerCustomer !== undefined
        ? { maxUsesPerCustomer: dto.maxUsesPerCustomer }
        : {}),
      ...(dto.maxApplicationsPerCart !== undefined
        ? { maxApplicationsPerCart: dto.maxApplicationsPerCart }
        : {}),
      ...(dto.canStack !== undefined ? { canStack: dto.canStack } : {}),
      ...(dto.stackable !== undefined ? { stackable: dto.stackable } : {}),
      ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
      ...(dto.badgeText !== undefined ? { badgeText: dto.badgeText } : {}),
      ...(dto.customerDescription !== undefined
        ? { customerDescription: dto.customerDescription }
        : {}),
      ...(dto.showBadgeOnProductCard !== undefined
        ? { showBadgeOnProductCard: dto.showBadgeOnProductCard }
        : {}),
      ...(dto.showBadgeOnProductPage !== undefined
        ? { showBadgeOnProductPage: dto.showBadgeOnProductPage }
        : {}),
      ...(dto.showPreCartPopup !== undefined
        ? { showPreCartPopup: dto.showPreCartPopup }
        : {}),
      ...(dto.popupTitle !== undefined ? { popupTitle: dto.popupTitle } : {}),
      ...(dto.popupDescription !== undefined
        ? { popupDescription: dto.popupDescription }
        : {}),
      ...(dto.popupAcceptLabel !== undefined
        ? { popupAcceptLabel: dto.popupAcceptLabel }
        : {}),
      ...(dto.popupDismissLabel !== undefined
        ? { popupDismissLabel: dto.popupDismissLabel }
        : {}),
      ...(dto.popupSuggestedProductId !== undefined
        ? { popupSuggestedProductId: dto.popupSuggestedProductId }
        : {}),
      ...(dto.popupSuggestedCategoryId !== undefined
        ? { popupSuggestedCategoryId: dto.popupSuggestedCategoryId }
        : {}),
    });

    await this.applyRelations(promotion, dto);

    const saved = await this.saveAndReload(promotion);

    this.promotionsRepository.invalidateCache();

    return { data: this.present(saved, new Date()) };
  }

  async remove(id: number) {
    const promotion = await this.promotionRepo.findOne({ where: { id } });

    if (!promotion) {
      throw new NotFoundException('پروموشن یافت نشد.');
    }

    await this.promotionRepo.remove(promotion);
    this.promotionsRepository.invalidateCache();

    return { message: 'پروموشن حذف شد.' };
  }

  async setActive(id: number, isActive: boolean) {
    const promotion = await this.promotionRepo.findOne({ where: { id } });

    if (!promotion) {
      throw new NotFoundException('پروموشن یافت نشد.');
    }

    promotion.isActive = isActive;
    await this.promotionRepo.save(promotion);
    this.promotionsRepository.invalidateCache();

    return this.findOne(id);
  }

  // =========================================================
  // پیش‌نمایش
  // =========================================================

  /**
   * پیش‌نمایش پروموشن پیش از فعال‌سازی:
   * - اگر محصول انتخاب شود: قیمت واقعی آن از دیتابیس خوانده می‌شود
   * - اگر تعداد داده شود: یک سبد مصنوعی با تکرار همان محصول‌ها ساخته می‌شود
   * - تاریخ دلخواه برای تست «قبل/بعد از انقضا»
   */
  async preview(id: number, dto: PreviewPromotionDto) {
    const promotion = await this.findPromotionEntity(id);
    const now = dto.now ? new Date(dto.now) : new Date();

    const products = await this.promotionsRepository.findProducts(
      dto.productIds ?? [],
    );

    const quantity = Math.max(1, Math.min(50, dto.quantity ?? 2));

    const lines: PromotionCartLine[] = [];

    if (products.length) {
      products.forEach((product, productIndex) => {
        const variant = pickCheapestVariant(product);
        const unitPrice = variant ? Number(variant.price) : 0;
        const categoryIds = (product.categories ?? []).map(c => c.id);

        lines.push({
          lineId: `preview-${product.id}`,
          variantId: variant?.id ?? null,
          productId: product.id,
          categoryIds,
          unitPrice,
          listPrice: unitPrice,
          quantity,
          addedAt: Date.now() + productIndex,
          title: product.title,
          slug: product.slug,
          image: product.image,
          stock: variant?.stock ?? 0,
        });
      });
    } else if (dto.cartValue) {
      lines.push({
        lineId: 'preview-cart',
        variantId: null,
        productId: 0,
        categoryIds: [],
        unitPrice: Math.round(dto.cartValue / quantity),
        quantity,
        addedAt: Date.now(),
        title: 'سبد آزمایشی',
      });
    }

    const prepared = await this.promotionsRepository.getActivePrepared();
    const promotionById = new Map(
      prepared.map(item => [item.promotion.id, item]),
    );

    const preparedPromotion = promotionById.get(promotion.id) ?? {
      promotion,
      scope: {
        products: new Set<number>(),
        categories: new Set<number>(),
        excludedProducts: new Set<number>(),
        excludedCategories: new Set<number>(),
        rewardProducts: new Set<number>(),
        rewardCategories: new Set<number>(),
      },
    };

    // برای پیش‌نمایش، پروموشن لازم نیست «فعال» باشد؛ فقط با زمان دلخواه سنجیده می‌شود
    const previewPromotion: Promotion = { ...promotion, isActive: true };

    const variants = products.flatMap(product => product.variants ?? []);
    const stockByVariant = new Map(
      variants.map(variant => [variant.id, Math.max(0, variant.stock ?? 0)]),
    );
    const priceByVariant = new Map(
      variants.map(variant => [variant.id, Number(variant.price)]),
    );
    const priceByProduct = new Map(
      products.map(product => [
        product.id,
        Number(pickCheapestVariant(product)?.price ?? 0),
      ]),
    );

    const result = coordinatePromotions({
      promotions: [previewPromotion],
      lines,
      options: {
        now,
        allowStacking: dto.allowStacking ?? true,
        acceptedRewards: { [promotion.id]: true },
        variantStock: (variantId: number | null, productId: number) =>
          variantId != null
            ? (stockByVariant.get(variantId) ?? Infinity)
            : (stockByVariant.get(
                products.find(p => p.id === productId)?.variants?.[0]?.id ?? -1,
              ) ?? Infinity),
        isRewardOutOfStock: (productId: number, variantId: number | null) => {
          if (variantId != null) {
            const stock = stockByVariant.get(variantId);

            return stock != null && stock < 1;
          }

          const product = products.find(p => p.id === productId);

          if (!product) {
            return false;
          }

          return !(product.variants ?? []).some(
            variant => (variant.stock ?? 0) > 0,
          );
        },
        priceOf: (productId: number, variantId: number | null) =>
          (variantId != null ? priceByVariant.get(variantId) : undefined) ??
          priceByProduct.get(productId) ??
          0,
      },
    });

    const evaluation =
      result.applied.find(item => item.promotionId === promotion.id) ??
      result.rejected.find(item => item.promotionId === promotion.id) ??
      null;

    const cartValue = lines.reduce(
      (sum, line) => sum + line.unitPrice * line.quantity,
      0,
    );

    return {
      data: {
        promotion: this.present(previewPromotion, now),
        state: promotionWindowState(previewPromotion, now),
        sampleCart: {
          lines,
          cartValue,
          itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
        },
        evaluation,
        applied: result.applied,
        rejected: result.rejected,
        suggestions: result.suggestions,
        totals: {
          originalPrice: cartValue,
          promotionDiscount: result.totalDiscount,
          freeItemValue: result.totalFreeItemValue,
          finalPrice: Math.max(
            0,
            cartValue - result.totalDiscount - result.totalFreeItemValue,
          ),
          freeShipping: result.freeShipping,
        },
        warnings: this.previewWarnings(promotion, products),
      },
    };
  }

  /**
   * شبیه‌سازی پروموشن با اقلام دلخواه (بدون نیاز به سبد واقعی).
   * همان موتور و همان اعدادی که سبد/سفارش از آن استفاده می‌کنند.
   */
  async simulate(dto: {
    promotionId: number;
    items?: { variantId: number; quantity: number }[];
    productIds?: number[];
    quantity?: number;
    now?: string;
    allowStacking?: boolean;
  }) {
    const promotion = await this.findPromotionEntity(dto.promotionId);
    const now = dto.now ? new Date(dto.now) : new Date();
    const quantity = Math.max(1, Math.min(20, dto.quantity ?? 1));

    const lines: PromotionCartLine[] = [];
    let index = 0;

    for (const item of dto.items ?? []) {
      const variant = await this.promotionRepo.manager.findOne(Variant, {
        where: { id: item.variantId },
        relations: { product: { categories: true }, color: true, size: true },
      });

      if (!variant?.product) {
        continue;
      }

      const unitPrice = Number(variant.price);

      lines.push({
        lineId: `sim-${variant.id}-${index}`,
        variantId: variant.id,
        productId: variant.product.id,
        categoryIds: (variant.product.categories ?? []).map(c => c.id),
        unitPrice,
        quantity: Math.max(1, item.quantity || 1),
        addedAt: Date.now() + index,
        title: variant.product.title,
        slug: variant.product.slug,
        image: variant.product.image,
        stock: variant.stock,
        colorName: variant.color?.name,
        sizeName: variant.size?.name,
      });

      index += 1;
    }

    if (!lines.length) {
      for (const productId of dto.productIds ?? []) {
        const product = await this.promotionRepo.manager.findOne(Product, {
          where: { id: productId },
          relations: { variants: { color: true, size: true }, categories: true },
        });

        if (!product) {
          continue;
        }

        const variant = pickCheapestVariant(product);
        const unitPrice = Number(variant?.price ?? 0);

        lines.push({
          lineId: `sim-product-${product.id}`,
          variantId: variant?.id ?? null,
          productId: product.id,
          categoryIds: (product.categories ?? []).map(c => c.id),
          unitPrice,
          quantity,
          addedAt: Date.now() + index,
          title: product.title,
          slug: product.slug,
          image: product.image,
          stock: variant?.stock ?? 0,
        });

        index += 1;
      }
    }

    const result = coordinatePromotions({
      promotions: [{ ...promotion, isActive: true }],
      lines,
      options: {
        now,
        allowStacking: dto.allowStacking ?? true,
        acceptedRewards: { [promotion.id]: true },
      },
    });

    const cartValue = lines.reduce(
      (sum, line) => sum + line.unitPrice * Math.max(0, line.quantity),
      0,
    );

    return {
      data: {
        cartValue,
        itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
        applied: result.applied,
        rejected: result.rejected,
        totals: {
          originalPrice: cartValue,
          promotionDiscount: result.totalDiscount,
          freeItemValue: result.totalFreeItemValue,
          finalPrice: Math.max(
            0,
            cartValue - result.totalDiscount - result.totalFreeItemValue,
          ),
          freeShipping: result.freeShipping,
        },
      },
    };
  }

  /** پیشنهادهای سبد فعلی کاربر (محاسبه بر اساس سبد واقعی) */
  async cartSuggestions(context: { userId?: number; guestId?: string }) {
    const cart = await this.cartRepo.findOne({
      where: context.userId
        ? { user: { id: context.userId } }
        : { guestId: context.guestId },
      relations: {
        items: {
          variant: { color: true, size: true, product: { categories: true } },
        },
      },
    });

    if (!cart || !cart.items?.length) {
      return { data: { suggestions: [], applied: [], notices: [] } };
    }

    const result = await this.evaluateCart({
      cart,
      userId: context.userId,
    });

    const dismissed = cart.dismissedPromotions ?? [];

    return {
      data: {
        suggestions: await this.enrichSuggestions(
          result.suggestions.filter(
            suggestion => !dismissed.includes(suggestion.promotionId),
          ),
        ),
        applied: result.applied,
        rejected: result.rejected,
        notices: result.notices,
        popupShownFor: cart.promotionPopupShownFor,
        acceptedPromotions: cart.acceptedPromotions ?? [],
      },
    };
  }

  /**
   * تکمیل داده‌های نمایشی پیشنهادها (نام، تصویر، اسلاگ، قیمت).
   *
   * موتور فقط شناسه‌ها را می‌داند؛ پاپ‌آپ باید کالای پیشنهادی را با نام و
   * تصویر نشان دهد تا مشتری بداند دقیقاً چه چیزی اضافه می‌شود. نبود این
   * داده‌ها باعث نمایش «کالای پیشنهادی» عمومی می‌شد.
   *
   * فقط موجودی/محصولات واجد شرایط تبلیغ نمی‌شوند؛ اگر محصولی موجود نباشد،
   * پیشنهاد بدون تصویر ولی با متن راهنما نمایش داده می‌شود.
   */
  private async enrichSuggestions(
    suggestions: PromotionSuggestion[],
  ): Promise<PromotionSuggestion[]> {
    const productIds = [
      ...new Set(
        suggestions
          .map(item => item.suggestedProduct?.productId)
          .filter((id): id is number => typeof id === 'number'),
      ),
    ];

    const products = productIds.length
      ? await this.promotionRepo.manager.find(Product, {
          where: { id: In(productIds) },
          relations: { variants: true },
        })
      : [];

    const byId = new Map(products.map(product => [product.id, product]));

    return suggestions.map(suggestion => {
      const suggested = suggestion.suggestedProduct;

      if (!suggested) {
        return suggestion;
      }

      const product = byId.get(suggested.productId);

      if (!product) {
        return suggestion;
      }

      const inStockVariants = (product.variants ?? []).filter(
        variant => (variant.stock ?? 0) > 0,
      );

      // اگر واریانت پیشنهادی موجود نیست، ارزان‌ترین واریانت موجود را پیشنهاد می‌دهیم
      const fallback = inStockVariants.sort(
        (a, b) => Number(a.price) - Number(b.price),
      )[0];

      const variantId =
        suggested.variantId != null &&
        inStockVariants.some(variant => variant.id === suggested.variantId)
          ? suggested.variantId
          : (fallback?.id ?? null);

      return {
        ...suggestion,
        suggestedProduct: {
          ...suggested,
          variantId,
          title: product.title,
          slug: product.slug,
          image: product.image ?? null,
          price:
            suggested.price ??
            (fallback ? Number(fallback.price) : undefined),
        },
      };
    });
  }

  // =========================================================
  // مشتری: ارزیابی سبد
  // =========================================================

  /** ارزیابی همهٔ پروموشن‌های فعال روی سبد مشتری */
  async evaluateCart(
    context: PromotionCartContext,
  ): Promise<PromotionCartResult & { rewardLines: PromotionCartLine[] }> {
    const { cart } = context;
    const now = context.now ?? new Date();
    const prepared = await this.promotionsRepository.getActivePrepared();
    const promotions = prepared.map(item => item.promotion);

    const lines = this.toCartLines(cart);
    const usage = await this.loadUsage(promotions.map(item => item.id), context.userId);

    const selectedRewards: Record<
      number,
      { productId: number; variantId: number | null }
    > = {};

    for (const entry of cart.selectedRewards ?? []) {
      selectedRewards[entry.promotionId] = {
        productId: entry.productId,
        variantId: entry.variantId ?? null,
      };
    }

    const acceptedRewards: Record<number, boolean> = {};

    for (const promotion of promotions) {
      const accepted =
        (cart.acceptedPromotions ?? []).includes(promotion.id) ||
        promotion.autoAddReward ||
        !promotion.requiresCustomerAcceptance;

      acceptedRewards[promotion.id] = accepted;
    }

    const result = coordinatePromotions({
      promotions,
      lines,
      options: {
        now,
        acceptedRewards,
        selectedRewards,
        usageByPromotion: usage,
        allowStacking: true,
        variantStock: (variantId, productId) => {
          const line = cart.items?.find(
            item => item.variant?.id === variantId,
          );

          if (line?.variant) {
            return Math.max(0, line.variant.stock ?? 0);
          }

          return Infinity;
        },
        // موجودی هدیهٔ انتخابی در لحظهٔ افزودن به سبد (addRewardToCart) و
        // دوباره در چک‌اوت اعتبارسنجی می‌شود؛ اینجا برای هدیهٔ از پیش موجود،
        // موجودی همان ردیف سبد کافی است.
        isRewardOutOfStock: (productId, variantId) =>
          lines.some(
            line =>
              line.productId === productId &&
              (variantId == null || line.variantId === variantId) &&
              (line.stock ?? 1) <= 0,
          ),
        priceOf: (productId, variantId) => {
          const line = lines.find(
            entry =>
              (variantId != null && entry.variantId === variantId) ||
              (variantId == null && entry.productId === productId),
          );

          return line?.unitPrice ?? 0;
        },
      },
    });

    return { ...result, rewardLines: [] };
  }

  /**
   * افزودن کالای هدیه به سبد (فقط اگر واقعاً رایگان شود).
   *
   * - اگر پروموشن «انتخاب با مشتری» باشد، واریانت/محصول باید در دامنهٔ پاداش
   *   باشد.
   * - موجودی واریانت باید حداقل برابر تعداد هدیه باشد.
   * - اگر همین هدیه قبلاً اضافه شده باشد دوباره اضافه نمی‌شود (مگر
   *   maxApplicationsPerCart بیشتر باشد).
   */
  async addRewardToCart(
    cart: Cart,
    params: { promotionId: number; variantId?: number; productId?: number; quantity?: number },
  ) {
    const promotion = await this.findPromotionEntity(params.promotionId);

    if (!isPromotionLive(promotion, new Date())) {
      throw new BadRequestException(
        'این پیشنهاد در حال حاضر فعال نیست.',
      );
    }

    const prepared = await this.promotionsRepository.getActivePrepared();
    const preparedPromotion = prepared.find(
      item => item.promotion.id === promotion.id,
    );

    const foundVariant = params.variantId
      ? await this.promotionRepo.manager.findOne(Variant, {
          where: { id: params.variantId },
          relations: {
            product: { categories: true },
            color: true,
            size: true,
          },
        })
      : null;

    if (params.variantId && !foundVariant) {
      throw new NotFoundException('واریانت انتخاب‌شده یافت نشد.');
    }

    const productId = params.productId ?? foundVariant?.product?.id;

    if (!productId) {
      throw new BadRequestException('محصول هدیه مشخص نشده است.');
    }

    const product = await this.promotionRepo.manager.findOne(Product, {
      where: { id: productId },
      relations: { variants: { color: true, size: true }, categories: true },
    });

    if (!product) {
      throw new NotFoundException('محصول هدیه یافت نشد.');
    }

    const categoryIds = (product.categories ?? []).map(c => c.id);

    const inRewardScope = isProductInRewardScope(
      promotion,
      product.id,
      categoryIds,
      preparedPromotion
        ? {
            rewardProducts: preparedPromotion.scope.rewardProducts,
            rewardCategories: preparedPromotion.scope.rewardCategories,
            excludedProducts: preparedPromotion.scope.excludedProducts,
            excludedCategories: preparedPromotion.scope.excludedCategories,
          }
        : undefined,
    );

    if (!inRewardScope) {
      throw new BadRequestException(
        'این محصول در محدودهٔ پیشنهاد قرار ندارد.',
      );
    }

    const variant = foundVariant ?? pickCheapestVariant(product, { requireStock: true });

    if (!variant) {
      throw new BadRequestException('این محصول موجود نیست.');
    }

    const quantity = Math.max(1, Math.min(20, params.quantity ?? 1));

    if ((variant.stock ?? 0) < quantity) {
      throw new BadRequestException('موجودی این هدیه کافی نیست.');
    }

    const existingRewards = (cart.items ?? []).filter(
      item => item.promotionRewardId === promotion.id,
    );

    const maxApplications = Math.max(1, promotion.maxApplicationsPerCart || 1);

    if (existingRewards.length >= maxApplications) {
      throw new BadRequestException(
        'هدیهٔ این پیشنهاد قبلاً در سبد شما هست.',
      );
    }

    return {
      promotion,
      product,
      variantId: variant.id,
      quantity,
      price: Number(variant.price),
    };
  }

  // =========================================================
  // ثبت استفاده و رویدادها
  // =========================================================

  /** ثبت استفاده در تراکنش پرداخت */
  async recordRedemption(
    manager: {
      insert: (entity: unknown, values: unknown) => Promise<unknown>;
    },
    params: {
      promotionIds: { id: number; discountAmount: number }[];
      orderId: number;
      userId: number | null;
    },
  ) {
    for (const item of params.promotionIds) {
      await manager.insert(PromotionRedemption, {
        promotionId: item.id,
        userId: params.userId,
        orderId: params.orderId,
        discountAmount: item.discountAmount,
      });
    }
  }

  async logEvent(params: {
    promotionId: number;
    userId?: number | null;
    kind: PromotionEventKind;
    message?: string | null;
    meta?: Record<string, unknown> | null;
  }) {
    try {
      await this.eventRepo.insert({
        promotionId: params.promotionId,
        userId: params.userId ?? null,
        kind: params.kind,
        message: params.message ?? null,
        meta: (params.meta ?? null) as never,
      });
    } catch (error) {
      this.logger.warn(
        `ثبت رویداد پروموشن ${params.promotionId} ناموفق بود: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** نشان «در این تخفیف چقدر صرفه‌جویی می‌کنی» برای صفحهٔ محصول */
  async getProductBadges(product: Product): Promise<
    {
      promotionId: number;
      badgeText: string;
      description: string | null;
      type: PromotionType;
      hint: string;
    }[]
  > {
    const now = new Date();
    const prepared = await this.promotionsRepository.getActivePrepared();
    const categoryIds = (product.categories ?? []).map(c => c.id);
    const variant = pickCheapestVariant(product);
    const price = Number(variant?.price ?? 0);

    const badgeText = (promotion: Promotion) =>
      promotion.badgeText?.trim() ||
      defaultBadgeText(promotion);

    const badges: {
      promotionId: number;
      badgeText: string;
      description: string | null;
      type: PromotionType;
      hint: string;
    }[] = [];

    for (const { promotion, scope } of prepared) {
      if (!isPromotionLive(promotion, now)) {
        continue;
      }

      if (
        !promotion.showBadgeOnProductCard &&
        !promotion.showBadgeOnProductPage
      ) {
        continue;
      }

      if (
        !isProductInScope(promotion, product.id, categoryIds, {
          products: scope.products,
          categories: scope.categories,
          excludedProducts: scope.excludedProducts,
          excludedCategories: scope.excludedCategories,
        })
      ) {
        continue;
      }

      const text = badgeText(promotion);

      badges.push({
        promotionId: promotion.id,
        badgeText: text,
        description: promotion.customerDescription ?? null,
        type: promotion.type,
        hint: describePromotion(promotion, price),
      });
    }

    return badges;
  }

  /** شناسهٔ پروموشن‌هایی که ادمین برای آن‌ها نشان محصول را روشن کرده */
  async getProductCardBadgeMap(): Promise<
    Map<number, { promotionId: number; text: string }>
  > {
    const prepared = await this.promotionsRepository.getActivePrepared();
    const now = new Date();
    const map = new Map<number, { promotionId: number; text: string }>();

    for (const { promotion, scope } of prepared) {
      if (!promotion.showBadgeOnProductCard || !isPromotionLive(promotion, now)) {
        continue;
      }

      const text = promotion.badgeText?.trim() || defaultBadgeText(promotion);

      for (const productId of scope.products) {
        map.set(productId, { promotionId: promotion.id, text });
      }
    }

    return map;
  }

  // =========================================================
  // ابزارهای داخلی
  // =========================================================

  async getActivePromotionsPublic() {
    const prepared = await this.promotionsRepository.getActivePrepared();
    const now = new Date();

    return prepared
      .filter(item => item.promotion.isActive)
      .map(item => ({
        ...this.present(item.promotion, now),
        status: promotionWindowState(item.promotion, now),
      }));
  }

  /** پروموشن فعال (با اعتبار زمانی) — برای اعتبارسنجی سفارش/پرداخت */
  async findActiveById(id: number): Promise<Promotion | null> {
    const promotion = await this.promotionRepo.findOne({ where: { id } });

    if (!promotion || !isPromotionLive(promotion, new Date())) {
      return null;
    }

    return promotion;
  }

  private async findPromotionEntity(id: number): Promise<Promotion> {
    const promotion = await this.promotionRepo.findOne({
      where: { id },
      relations: {
        products: true,
        categories: true,
        excludedProducts: true,
        excludedCategories: true,
        rewardProducts: true,
        rewardCategories: true,
        suggestedProduct: true,
        suggestedCategory: true,
        popupSuggestedProduct: true,
        popupSuggestedCategory: true,
      },
    });

    if (!promotion) {
      throw new NotFoundException('پروموشن یافت نشد.');
    }

    return promotion;
  }

  private async saveAndReload(promotion: Promotion): Promise<Promotion> {
    await this.promotionRepo.save(promotion);

    return this.findPromotionEntity(promotion.id);
  }

  private async applyRelations(
    promotion: Promotion,
    dto: Partial<CreatePromotionDto>,
  ) {
    if (dto.productIds !== undefined) {
      promotion.products = await this.findBy(Product, dto.productIds);
    }

    if (dto.categoryIds !== undefined) {
      promotion.categories = await this.findBy(Category, dto.categoryIds);
    }

    if (dto.excludedProductIds !== undefined) {
      promotion.excludedProducts = await this.findBy(
        Product,
        dto.excludedProductIds,
      );
    }

    if (dto.excludedCategoryIds !== undefined) {
      promotion.excludedCategories = await this.findBy(
        Category,
        dto.excludedCategoryIds,
      );
    }

    if (dto.rewardProductIds !== undefined) {
      promotion.rewardProducts = await this.findBy(
        Product,
        dto.rewardProductIds,
      );
    }

    if (dto.rewardCategoryIds !== undefined) {
      promotion.rewardCategories = await this.findBy(
        Category,
        dto.rewardCategoryIds,
      );
    }
  }

  private async findBy<T extends Product | Category>(
    entity: new () => T,
    ids: number[],
  ): Promise<T[]> {
    if (!ids.length) {
      return [];
    }

    return this.promotionRepo.manager.find(entity as never, {
      where: { id: In(ids) } as never,
    }) as Promise<T[]>;
  }

  private toCartLines(cart: Cart): PromotionCartLine[] {
    return (cart.items ?? [])
      .filter(item => item.variant?.product)
      .map((item, index) => {
        const variant = item.variant;
        const product = variant.product;
        const price = Number(variant.price);

        return {
          lineId: item.id,
          variantId: variant.id,
          productId: product.id,
          categoryIds: (product.categories ?? []).map(c => c.id),
          unitPrice: price,
          listPrice: price,
          quantity: item.quantity,
          addedAt: item.id ?? index,
          title: product.title,
          slug: product.slug,
          image: product.image,
          stock: variant.stock,
          colorName: variant.color?.name,
          sizeName: variant.size?.name,
          isFreeReward: !!item.promotionRewardId,
          rewardPromotionId: item.promotionRewardId,
        } satisfies PromotionCartLine;
      });
  }

  private async loadUsage(
    promotionIds: number[],
    userId?: number,
  ): Promise<Record<number, { total: number; perCustomer: number }>> {
    const usage: Record<number, { total: number; perCustomer: number }> = {};

    if (!promotionIds.length) {
      return usage;
    }

    const rows = await this.redemptionRepo
      .createQueryBuilder('redemption')
      .select('redemption.promotionId', 'promotionId')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        userId
          ? 'SUM(CASE WHEN redemption.userId = :userId THEN 1 ELSE 0 END)'
          : '0',
        'perCustomer',
      )
      .where('redemption.promotionId IN (:...promotionIds)', { promotionIds })
      .setParameter('userId', userId ?? -1)
      .groupBy('redemption.promotionId')
      .getRawMany<{ promotionId: number; total: string; perCustomer: string }>();

    for (const row of rows) {
      usage[Number(row.promotionId)] = {
        total: Number(row.total ?? 0),
        perCustomer: Number(row.perCustomer ?? 0),
      };
    }

    return usage;
  }

  private async countUsageFor(
    promotionIds: number[],
  ): Promise<Map<number, { total: number; perCustomer: number }>> {
    const map = new Map<number, { total: number; perCustomer: number }>();

    if (!promotionIds.length) {
      return map;
    }

    const rows = await this.redemptionRepo
      .createQueryBuilder('redemption')
      .select('redemption.promotionId', 'promotionId')
      .addSelect('COUNT(*)', 'total')
      .addSelect('COUNT(DISTINCT redemption.userId)', 'customers')
      .where('redemption.promotionId IN (:...promotionIds)', { promotionIds })
      .groupBy('redemption.promotionId')
      .getRawMany<{ promotionId: number; total: string; customers: string }>();

    for (const row of rows) {
      map.set(Number(row.promotionId), {
        total: Number(row.total ?? 0),
        perCustomer: Number(row.customers ?? 0),
      });
    }

    return map;
  }

  private assertConfiguration(dto: Partial<CreatePromotionDto>) {
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    if (startsAt && expiresAt && startsAt >= expiresAt) {
      throw new BadRequestException(
        'زمان پایان باید بعد از زمان شروع باشد.',
      );
    }

    if (
      (dto.type === PromotionType.CHEAPER_ITEM_PAIR ||
        dto.type === PromotionType.BUY_X_GET_PERCENT_OFF ||
        dto.type === PromotionType.SPEND_AND_SAVE ||
        dto.type === PromotionType.CART_DISCOUNT) &&
      dto.rewardType !== PromotionRewardType.FIXED &&
      dto.rewardType !== PromotionRewardType.PERCENTAGE &&
      dto.rewardType !== PromotionRewardType.FIXED_BUNDLE_PRICE
    ) {
      throw new BadRequestException(
        'برای این نوع پروموشن، پاداش باید درصدی یا مبلغ ثابت باشد.',
      );
    }

    if (
      dto.rewardType === PromotionRewardType.PERCENTAGE &&
      (dto.rewardValue == null || dto.rewardValue <= 0 || dto.rewardValue > 100)
    ) {
      throw new BadRequestException('درصد تخفیف باید بین ۱ تا ۱۰۰ باشد.');
    }

    if (
      dto.type === PromotionType.BUY_X_GET_Y_SAME_GROUP &&
      (!dto.requiredQuantity || dto.requiredQuantity < 1)
    ) {
      throw new BadRequestException('تعداد کالای پرداختی (X) الزامی است.');
    }

    if (
      dto.type === PromotionType.BUY_X_GET_Y_SAME_GROUP &&
      (!dto.freeQuantity || dto.freeQuantity < 1)
    ) {
      throw new BadRequestException('تعداد کالای رایگان (Y) الزامی است.');
    }

    if (dto.type === PromotionType.FIXED_PRICE_BUNDLE) {
      if (!dto.rewardValue || dto.rewardValue <= 0) {
        throw new BadRequestException('قیمت ثابت باندل الزامی است.');
      }

      if (!dto.minQuantity || dto.minQuantity < 2) {
        throw new BadRequestException(
          'تعداد اقلام باندل باید حداقل ۲ باشد.',
        );
      }
    }

    if (dto.type === PromotionType.BUY_TRIGGER_GET_REWARD) {
      if (!dto.rewardProductIds?.length && !dto.suggestedProductId) {
        if (!dto.rewardCategoryIds?.length && !dto.suggestedCategoryId) {
          throw new BadRequestException(
            'برای این نوع، محصول یا دستهٔ هدیه را انتخاب کنید.',
          );
        }
      }
    }

    if (
      dto.scope === PromotionScope.PRODUCTS &&
      !dto.productIds?.length &&
      dto.type !== PromotionType.BUY_TRIGGER_GET_REWARD
    ) {
      throw new BadRequestException(
        'دامنهٔ «محصولات انتخاب‌شده» نیاز به انتخاب حداقل یک محصول دارد.',
      );
    }
  }

  private previewWarnings(promotion: Promotion, products: Product[]) {
    const warnings: string[] = [];

    if (!promotion.badgeText?.trim()) {
      warnings.push(
        'متن نشان تعریف نشده است؛ متن پیش‌فرض بر اساس نوع پروموشن نمایش داده می‌شود.',
      );
    }

    if (promotion.type === PromotionType.BUY_TRIGGER_GET_REWARD) {
      const rewardProductIds = new Set(
        (promotion.rewardProducts ?? []).map(product => product.id),
      );

      if (
        products.length &&
        products.every(product => rewardProductIds.has(product.id))
      ) {
        warnings.push(
          'کالاهای انتخاب‌شده همه در محدودهٔ هدیه هستند؛ هیچ کالای محرکی در نمونهٔ سبد نیست.',
        );
      }
    }

    const outOfStock = products.filter(
      product => !(product.variants ?? []).some(v => (v.stock ?? 0) > 0),
    );

    if (outOfStock.length) {
      warnings.push(
        `${outOfStock.length} محصول انتخاب‌شده موجودی ندارد و هدیه/تخفیف روی آن واقع‌گرایانه نیست.`,
      );
    }

    return warnings;
  }

  private present(
    promotion: Promotion,
    now: Date = new Date(),
    usage?: { total: number; perCustomer: number },
  ) {
    return {
      ...promotion,
      rewardValue:
        promotion.rewardValue == null ? null : Number(promotion.rewardValue),
      maxDiscountAmount:
        promotion.maxDiscountAmount == null
          ? null
          : Number(promotion.maxDiscountAmount),
      minCartValue: Number(promotion.minCartValue ?? 0),
      status: promotionWindowState(promotion, now),
      productIds: (promotion.products ?? []).map(product => product.id),
      categoryIds: (promotion.categories ?? []).map(category => category.id),
      excludedProductIds: (promotion.excludedProducts ?? []).map(p => p.id),
      excludedCategoryIds: (promotion.excludedCategories ?? []).map(c => c.id),
      rewardProductIds: (promotion.rewardProducts ?? []).map(p => p.id),
      rewardCategoryIds: (promotion.rewardCategories ?? []).map(c => c.id),
      usage: usage ?? { total: 0, perCustomer: 0 },
      badgeLabel: promotion.badgeText?.trim() || defaultBadgeText(promotion),
    };
  }

  /** برای اسنپ‌پی/فاکتور: یافتن سفارش مربوط به ارزیابی (کلیدهای ثابت) */
  describeForOrder(evaluations: PromotionEvaluation[]) {
    return evaluations.map(evaluation => ({
      promotionId: evaluation.promotionId,
      name: evaluation.name,
      type: evaluation.type,
      discountAmount: evaluation.discountAmount,
      freeItemValue: evaluation.freeItemValue,
      allocations: evaluation.allocations,
    }));
  }

  /** سفارش‌های استفاده‌کننده از یک پروموشن (برای گزارش/پشتیبانی) */
  async findOrdersWithPromotion(promotionId: number) {
    const redemptions = await this.redemptionRepo.find({
      where: { promotionId },
      relations: { order: { user: true } },
      order: { usedAt: 'DESC' },
      take: 200,
    });

    return redemptions.map(redemption => ({
      orderId: redemption.orderId,
      orderNumber: redemption.order?.orderNumber ?? null,
      userId: redemption.userId,
      discountAmount: Number(redemption.discountAmount ?? 0),
      usedAt: redemption.usedAt,
    }));
  }
}

export function pickCheapestVariant(
  product: Product | null | undefined,
  options: { requireStock?: boolean } = {},
) {
  const variants = [...(product?.variants ?? [])];

  if (!variants.length) {
    return null;
  }

  const candidates = options.requireStock
    ? variants.filter(variant => (variant.stock ?? 0) > 0)
    : variants;

  const pool = candidates.length ? candidates : options.requireStock ? [] : variants;

  return (
    pool.sort((a, b) => Number(a.price) - Number(b.price))[0] ?? null
  );
}

/** متن نشان پیش‌فرض، اگر ادمین آن را وارد نکرده باشد */
export function defaultBadgeText(promotion: Promotion): string {
  const percent = Number(promotion.rewardValue ?? 0);

  switch (promotion.type) {
    case PromotionType.CHEAPER_ITEM_PAIR:
      return `خرید ${promotion.pairSize || 2}، ${percent}٪ تخفیف روی ارزان‌تر`;

    case PromotionType.BUY_X_GET_Y_SAME_GROUP:
      return `خرید ${promotion.requiredQuantity}، ${promotion.freeQuantity} هدیه`;

    case PromotionType.BUY_TRIGGER_GET_REWARD:
      return 'با این خرید یک هدیه بگیرید';

    case PromotionType.SPEND_AND_SAVE:
      return promotion.rewardType === PromotionRewardType.PERCENTAGE
        ? `${percent}٪ تخفیف خرید`
        : `${percent.toLocaleString('fa-IR')} تومان تخفیف خرید`;

    case PromotionType.BUY_X_GET_PERCENT_OFF:
      return `خرید ${promotion.minQuantity}، ${percent}٪ تخفیف`;

    case PromotionType.FIXED_PRICE_BUNDLE:
      return `باندل ${promotion.minQuantity} کالا با قیمت ${percent.toLocaleString('fa-IR')} تومان`;

    case PromotionType.FREE_SHIPPING:
      return 'ارسال رایگان';

    case PromotionType.CART_DISCOUNT:
      return promotion.rewardType === PromotionRewardType.PERCENTAGE
        ? `${percent}٪ تخفیف سبد`
        : 'تخفیف سبد';

    default:
      return promotion.name;
  }
}

/** توضیح دقیق‌تر برای صفحهٔ محصول */
export function describePromotion(promotion: Promotion, price: number): string {
  const percent = Number(promotion.rewardValue ?? 0);

  switch (promotion.type) {
    case PromotionType.CHEAPER_ITEM_PAIR: {
      const save = Math.round((price * percent) / 100);

      return `این کالا در معاملهٔ «خرید ${promotion.pairSize || 2}» شرکت می‌کند؛ در هر جفت، ارزان‌تر تا ${percent}٪ (حدود ${save.toLocaleString('fa-IR')} تومان) تخفیف می‌گیرد.`;
    }

    case PromotionType.BUY_X_GET_Y_SAME_GROUP:
      return `با خرید ${promotion.requiredQuantity} کالا از این گروه، ${promotion.freeQuantity} کالا (ارزان‌تر) رایگان می‌شود.`;

    case PromotionType.BUY_TRIGGER_GET_REWARD:
      return 'این کالا مشمول پیشنهاد «خرید کن، هدیه بگیر» است؛ کالای هدیه در سبد رایگان محاسبه می‌شود.';

    case PromotionType.SPEND_AND_SAVE:
      return `با خرید حداقل ${Number(promotion.minCartValue ?? 0).toLocaleString('fa-IR')} تومان، ${percent}٪ تخفیف بگیرید.`;

    case PromotionType.FIXED_PRICE_BUNDLE:
      return `این کالا در باندل ${promotion.minQuantity} کالایی با قیمت ثابت ${percent.toLocaleString('fa-IR')} تومان قابل استفاده است.`;

    case PromotionType.FREE_SHIPPING:
      return 'مشمول ارسال رایگان.';

    default:
      return promotion.customerDescription ?? promotion.name;
  }
}

/** برای استفادهٔ تست‌ها / سایر ماژول‌ها */
export type { PreparedPromotion };
