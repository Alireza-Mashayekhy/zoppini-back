import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import { In, Repository } from 'typeorm';

import { Promotion } from './entities/promotion.entity';

/** اجزای آماده‌شده برای موتور: دامنه‌های بسط‌یافته و کش */
export interface ExpandedPromotionScope {
  products: Set<number>;
  categories: Set<number>;
  excludedProducts: Set<number>;
  excludedCategories: Set<number>;
  rewardProducts: Set<number>;
  rewardCategories: Set<number>;
}

export interface PreparedPromotion {
  promotion: Promotion;
  /** شناسهٔ محصولات/دسته‌های مشمول با زیرمجموعه‌ها */
  scope: ExpandedPromotionScope;
}

export const PROMOTIONS_CACHE_TTL_MS = 30_000;

@Injectable()
export class PromotionsRepository {
  private readonly logger = new Logger(PromotionsRepository.name);

  private cache: { promotions: PreparedPromotion[]; cachedAt: number } | null =
    null;

  private categoryChildren: {
    childrenByParent: Map<number, number[]>;
    cachedAt: number;
  } | null = null;

  constructor(
    @InjectRepository(Promotion)
    private readonly promotionRepo: Repository<Promotion>,

    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
  ) {}

  invalidateCache() {
    this.cache = null;
  }

  /** همهٔ پروموشن‌های فعال (بدون فیلتر زمانی؛ زمان در موتور بررسی می‌شود) */
  async getActivePrepared(): Promise<PreparedPromotion[]> {
    const now = Date.now();

    if (this.cache && now - this.cache.cachedAt < PROMOTIONS_CACHE_TTL_MS) {
      return this.cache.promotions;
    }

    const rows = await this.promotionRepo.find({
      where: { isActive: true },
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

    const prepared: PreparedPromotion[] = [];

    for (const promotion of rows) {
      const scope: ExpandedPromotionScope = {
        products: new Set((promotion.products ?? []).map(p => p.id)),
        categories: await this.expandCategories(
          (promotion.categories ?? []).map(c => c.id),
        ),
        excludedProducts: new Set(
          (promotion.excludedProducts ?? []).map(p => p.id),
        ),
        excludedCategories: await this.expandCategories(
          (promotion.excludedCategories ?? []).map(c => c.id),
        ),
        rewardProducts: new Set(
          (promotion.rewardProducts ?? []).map(p => p.id),
        ),
        rewardCategories: await this.expandCategories(
          (promotion.rewardCategories ?? []).map(c => c.id),
        ),
      };

      prepared.push({ promotion, scope });
    }

    this.cache = { promotions: prepared, cachedAt: now };

    return prepared;
  }

  /** دسته‌ی انتخاب‌شده + همهٔ زیرمجموعه‌ها */
  async expandCategories(ids: number[]): Promise<Set<number>> {
    const result = new Set<number>(ids);

    if (!ids.length) {
      return result;
    }

    const children = await this.getChildrenMap();
    const queue = [...ids];

    while (queue.length) {
      const current = queue.shift()!;

      for (const child of children.get(current) ?? []) {
        if (!result.has(child)) {
          result.add(child);
          queue.push(child);
        }
      }
    }

    return result;
  }

  /** محصولات همیشه موجود (برای اعتبارسنجی/پیش‌نمایش) */
  async findProducts(ids: number[]): Promise<Product[]> {
    if (!ids.length) {
      return [];
    }

    return this.promotionRepo.manager.find(Product, {
      where: { id: In(ids) },
      relations: { variants: { color: true, size: true }, categories: true },
    });
  }

  async findProductBySlug(slug: string): Promise<Product | null> {
    return this.promotionRepo.manager.findOne(Product, {
      where: [{ slug }, { slug: encodeURIComponent(slug) }],
      relations: { variants: { color: true, size: true }, categories: true },
    });
  }

  private async getChildrenMap(): Promise<Map<number, number[]>> {
    const now = Date.now();

    if (
      this.categoryChildren &&
      now - this.categoryChildren.cachedAt < PROMOTIONS_CACHE_TTL_MS
    ) {
      return this.categoryChildren.childrenByParent;
    }

    const rows = await this.categoryRepo
      .createQueryBuilder('category')
      .select(['category.id', 'category.parentId'])
      .getMany();

    const childrenByParent = new Map<number, number[]>();

    for (const row of rows) {
      if (row.parentId == null) {
        continue;
      }

      const parentId = Number(row.parentId);

      if (!Number.isFinite(parentId)) {
        continue;
      }

      const list = childrenByParent.get(parentId) ?? [];
      list.push(row.id);
      childrenByParent.set(parentId, list);
    }

    this.categoryChildren = { childrenByParent, cachedAt: now };

    return childrenByParent;
  }
}
