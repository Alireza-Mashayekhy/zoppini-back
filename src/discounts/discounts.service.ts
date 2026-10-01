import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cart } from 'src/cart/entities/cart.entity';
import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import { User } from 'src/users/entities/user.entity';
import { EntityManager, In, Repository } from 'typeorm';

import { CreateDiscountDto } from './dto/create-discount.dto';
import { ListDiscountsQueryDto } from './dto/list-discounts.dto';
import { UpdateDiscountDto } from './dto/update-discount.dto';
import {
  Discount,
  DiscountKind,
  DiscountType,
  OPENING_DISCOUNT_CODE,
} from './entities/discount.entity';
import { DiscountUsage } from './entities/discount-code-usage.entity';
import { DiscountRedemption } from './entities/discount-redemption.entity';

const SURVEY_DISCOUNT_CODE_PREFIX = 'SURVEY-';

const HARDCODED_EXCLUDED_CATEGORY_ROOT_IDS: readonly number[] = [85];

const OPENING_EXCLUDED_CATEGORY_IDS: readonly number[] = [86, 93, 94, 97, 98];

const CATEGORY_TREE_CACHE_TTL_MS = 5 * 60_000;

const SALES_CACHE_TTL_MS = 30_000;

/**
 * یک فروش ویژهٔ فعال، همراه با مجموعهٔ دسته‌بندی‌های مشمول
 * (دسته‌های انتخاب‌شده + همهٔ زیرمجموعه‌هایشان)
 */
export type ActiveSale = Discount & { scopeCategoryIds: Set<number> };

export interface SaleResult {
  discount: ActiveSale;
  discountAmount: number;
  finalPrice: number;
}

export interface CartLineInput {
  productId: number;
  quantity: number;
  /** قیمت اصلی هر واحد (قبل از فروش ویژه) */
  price: number;
  categoryIds: number[];
}

export interface PricedCartLine extends CartLineInput {
  /** قیمت اصلی هر واحد */
  originalPrice: number;
  /** قیمت هر واحد پس از فروش ویژه (مبلغی که مشتری می‌پردازد، قبل از کد تخفیف) */
  unitPrice: number;
  /** تخفیف فروش ویژه برای هر واحد */
  saleDiscountPerUnit: number;
  isOnSale: boolean;
  sale: ActiveSale | null;
}

export interface CodeEligibleLine {
  productId: number;
  quantity: number;
  /** قیمت هر واحد پس از فروش ویژه */
  price: number;
  categoryIds: number[];
  isOnSale?: boolean;
}

@Injectable()
export class DiscountService implements OnModuleInit {
  private readonly logger = new Logger(DiscountService.name);

  constructor(
    @InjectRepository(Discount)
    private readonly discountRepo: Repository<Discount>,

    @InjectRepository(DiscountUsage)
    private readonly usageRepo: Repository<DiscountUsage>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    @InjectRepository(DiscountRedemption)
    private readonly redemptionRepo: Repository<DiscountRedemption>,

    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,

    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,

    @InjectRepository(Cart)
    private readonly cartRepo: Repository<Cart>,
  ) {}

  private categoryTreeCache: {
    childrenByParentId: Map<string, number[]>;
    cachedAt: number;
  } | null = null;

  private salesCache: { sales: ActiveSale[]; cachedAt: number } | null = null;

  // =========================================================
  // CREATE
  // =========================================================

  async onModuleInit() {
    try {
      const result = await this.discountRepo.query(
        `UPDATE discounts d
         SET d.kind = ?
         WHERE d.kind = ?
           AND (
             EXISTS (SELECT 1 FROM discount_products dp WHERE dp.discount_id = d.id)
             OR EXISTS (SELECT 1 FROM discount_categories dc WHERE dc.discount_id = d.id)
           )
           AND NOT EXISTS (SELECT 1 FROM discount_users du WHERE du.discount_id = d.id)`,
        [DiscountKind.SALE, DiscountKind.CODE],
      );

      const affected = result?.affectedRows ?? 0;

      if (affected > 0) {
        this.logger.log(
          `🏷️ ${affected} تخفیف قدیمیِ محصول/دسته‌محور به «فروش ویژه» تبدیل شد.`,
        );
        this.invalidateSalesCache();
      }
    } catch (error) {
      this.logger.error(
        'تبدیل تخفیف‌های قدیمی به فروش ویژه ناموفق بود.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async create(dto: CreateDiscountDto) {
    const kind = dto.kind ?? DiscountKind.CODE;

    const startsAt = new Date(dto.startsAt);
    const expiresAt = new Date(dto.expiresAt);

    this.assertCommonRules(dto.type, dto.value, startsAt, expiresAt);

    const discount = this.discountRepo.create({
      kind,
      type: dto.type,
      value: dto.value,
      maxDiscountAmount: dto.maxDiscountAmount ?? null,
      minOrderAmount: dto.minOrderAmount ?? null,
      startsAt,
      expiresAt,
      isActive: dto.isActive ?? true,
      users: [],
      products: [],
      categories: [],
      excludedProducts: [],
      excludedCategories: [],
    });

    if (kind === DiscountKind.SALE) {
      discount.title = this.normalizeTitle(dto.title);
      discount.code = null;
      discount.minOrderAmount = null;
      discount.maxUsesPerUser = null;
      discount.maxTotalUses = null;
      discount.excludeSaleItems = false;

      discount.products = await this.loadProducts(dto.productIds);
      discount.categories = await this.loadCategories(dto.categoryIds);
      this.assertSaleRules(discount);
    } else {
      discount.title = dto.title?.trim() || null;
      discount.code = await this.normalizeUniqueCode(dto.code);
      discount.minOrderAmount = dto.minOrderAmount ?? null;
      discount.maxUsesPerUser =
        dto.maxUsesPerUser === undefined ? 1 : dto.maxUsesPerUser;
      discount.maxTotalUses = dto.maxTotalUses ?? null;
      discount.excludeSaleItems = dto.excludeSaleItems ?? false;

      discount.users = await this.loadUsers(dto.userIds);
      discount.excludedProducts = await this.loadProducts(
        dto.excludedProductIds,
        'محصولات مستثنا',
      );
      discount.excludedCategories = await this.loadCategories(
        dto.excludedCategoryIds,
        'دسته‌بندی‌های مستثنا',
      );
    }

    const saved = await this.discountRepo.save(discount);

    this.invalidateSalesCache();

    return saved;
  }

  // =========================================================
  // FIND ALL
  // =========================================================

  async findAll(query: ListDiscountsQueryDto = {}) {
    const qb = this.discountRepo
      .createQueryBuilder('discount')
      .orderBy('discount.createdAt', 'DESC');

    if (query.kind) {
      qb.andWhere('discount.kind = :kind', { kind: query.kind });
    }

    if (query.search?.trim()) {
      qb.andWhere(
        '(discount.code LIKE :search OR discount.title LIKE :search)',
        {
          search: `%${query.search.trim()}%`,
        },
      );
    }

    const discounts = await qb.getMany();

    const ids = discounts.map(discount => discount.id);

    const [usedCounts, users, products, categories, exProducts, exCategories] =
      await Promise.all([
        this.getUsedCounts(ids),
        this.getRelationCounts('discount_users', ids),
        this.getRelationCounts('discount_products', ids),
        this.getRelationCounts('discount_categories', ids),
        this.getRelationCounts('discount_excluded_products', ids),
        this.getRelationCounts('discount_excluded_categories', ids),
      ]);

    return discounts.map(discount =>
      Object.assign(discount, {
        usedCount: usedCounts.get(discount.id) ?? 0,
        usersCount: users.get(discount.id) ?? 0,
        productsCount: products.get(discount.id) ?? 0,
        categoriesCount: categories.get(discount.id) ?? 0,
        excludedProductsCount: exProducts.get(discount.id) ?? 0,
        excludedCategoriesCount: exCategories.get(discount.id) ?? 0,
      }),
    );
  }

  /**
   * تعداد ردیف‌های جدول واسط (کاربر/محصول/دسته) برای هر تخفیف
   */
  private async getRelationCounts(
    table:
      | 'discount_users'
      | 'discount_products'
      | 'discount_categories'
      | 'discount_excluded_products'
      | 'discount_excluded_categories',
    discountIds: number[],
  ) {
    const result = new Map<number, number>();

    if (!discountIds.length) {
      return result;
    }

    const rows: { discountId: number | string; count: number | string }[] =
      await this.discountRepo.query(
        `SELECT discount_id AS discountId, COUNT(*) AS count
         FROM ${table}
         WHERE discount_id IN (${discountIds.map(() => '?').join(',')})
         GROUP BY discount_id`,
        discountIds,
      );

    for (const row of rows) {
      result.set(Number(row.discountId), Number(row.count));
    }

    return result;
  }

  async findOne(id: number) {
    const discount = await this.discountRepo.findOne({
      where: { id },
      relations: {
        users: true,
        categories: true,
        products: true,
        excludedProducts: true,
        excludedCategories: true,
      },
    });

    if (!discount) {
      throw new NotFoundException('تخفیف پیدا نشد.');
    }

    const usedCounts = await this.getUsedCounts([id]);

    return Object.assign(discount, { usedCount: usedCounts.get(id) ?? 0 });
  }

  // =========================================================
  // UPDATE
  // =========================================================

  async update(id: number, dto: UpdateDiscountDto) {
    const discount = await this.discountRepo.findOne({
      where: { id },
      relations: {
        users: true,
        categories: true,
        products: true,
        excludedProducts: true,
        excludedCategories: true,
      },
    });

    if (!discount) {
      throw new NotFoundException('تخفیف پیدا نشد.');
    }

    const isSale = discount.kind === DiscountKind.SALE;

    if (dto.type !== undefined) {
      discount.type = dto.type;
    }

    if (dto.value !== undefined) {
      discount.value = dto.value;
    }

    if (dto.maxDiscountAmount !== undefined) {
      discount.maxDiscountAmount = dto.maxDiscountAmount;
    }

    if (dto.startsAt !== undefined) {
      discount.startsAt = new Date(dto.startsAt);
    }

    if (dto.expiresAt !== undefined) {
      discount.expiresAt = new Date(dto.expiresAt);
    }

    if (dto.isActive !== undefined) {
      discount.isActive = dto.isActive;
    }

    this.assertCommonRules(
      discount.type,
      Number(discount.value),
      discount.startsAt,
      discount.expiresAt,
    );

    if (isSale) {
      if (dto.title !== undefined) {
        discount.title = this.normalizeTitle(dto.title);
      }

      if (dto.productIds !== undefined) {
        discount.products = await this.loadProducts(dto.productIds);
      }

      if (dto.categoryIds !== undefined) {
        discount.categories = await this.loadCategories(dto.categoryIds);
      }

      this.assertSaleRules(discount);
    } else {
      if (dto.title !== undefined) {
        discount.title = dto.title?.trim() || null;
      }

      if (dto.code !== undefined) {
        discount.code = await this.normalizeUniqueCode(dto.code, discount.id);
      }

      if (dto.minOrderAmount !== undefined) {
        discount.minOrderAmount = dto.minOrderAmount;
      }

      if (dto.maxUsesPerUser !== undefined) {
        discount.maxUsesPerUser = dto.maxUsesPerUser;
      }

      if (dto.maxTotalUses !== undefined) {
        discount.maxTotalUses = dto.maxTotalUses;
      }

      if (dto.excludeSaleItems !== undefined) {
        discount.excludeSaleItems = dto.excludeSaleItems;
      }

      if (dto.userIds !== undefined) {
        discount.users = await this.loadUsers(dto.userIds);
      }

      if (dto.excludedProductIds !== undefined) {
        discount.excludedProducts = await this.loadProducts(
          dto.excludedProductIds,
          'محصولات مستثنا',
        );
      }

      if (dto.excludedCategoryIds !== undefined) {
        discount.excludedCategories = await this.loadCategories(
          dto.excludedCategoryIds,
          'دسته‌بندی‌های مستثنا',
        );
      }
    }

    const saved = await this.discountRepo.save(discount);

    this.invalidateSalesCache();

    return saved;
  }

  // =========================================================
  // DELETE
  // =========================================================

  async remove(id: number) {
    const discount = await this.discountRepo.findOne({
      where: { id },
    });

    if (!discount) {
      throw new NotFoundException('تخفیف پیدا نشد.');
    }

    await this.discountRepo.remove(discount);

    this.invalidateSalesCache();

    return {
      message:
        discount.kind === DiscountKind.SALE
          ? 'فروش ویژه با موفقیت حذف شد.'
          : 'کد تخفیف با موفقیت حذف شد.',
    };
  }

  private assertCommonRules(
    type: DiscountType,
    value: number,
    startsAt: Date,
    expiresAt: Date,
  ) {
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('تاریخ شروع یا پایان معتبر نیست.');
    }

    if (expiresAt <= startsAt) {
      throw new BadRequestException('تاریخ پایان باید بعد از تاریخ شروع باشد.');
    }

    if (type === DiscountType.PERCENTAGE && value > 100) {
      throw new BadRequestException('درصد تخفیف نمی‌تواند بیشتر از 100 باشد.');
    }

    if (value <= 0) {
      throw new BadRequestException('مقدار تخفیف باید بیشتر از صفر باشد.');
    }
  }

  private assertSaleRules(discount: Discount) {
    if (!discount.products?.length && !discount.categories?.length) {
      throw new BadRequestException(
        'برای فروش ویژه حداقل یک محصول یا دسته‌بندی انتخاب کنید.',
      );
    }
  }

  private normalizeTitle(title?: string | null) {
    const value = title?.trim();

    if (!value) {
      throw new BadRequestException('عنوان فروش ویژه الزامی است.');
    }

    return value;
  }

  private async normalizeUniqueCode(code?: string | null, ignoreId?: number) {
    const normalized = code?.trim().toUpperCase();

    if (!normalized) {
      throw new BadRequestException('کد تخفیف الزامی است.');
    }

    const duplicate = await this.discountRepo.findOne({
      where: { code: normalized },
    });

    if (duplicate && duplicate.id !== ignoreId) {
      throw new BadRequestException('این کد تخفیف قبلاً ثبت شده است.');
    }

    return normalized;
  }

  private async loadUsers(ids?: number[]) {
    const unique = this.uniqueIds(ids);

    if (!unique.length) {
      return [];
    }

    const users = await this.userRepo.find({ where: { id: In(unique) } });

    if (users.length !== unique.length) {
      throw new BadRequestException('بعضی از کاربران انتخاب‌شده وجود ندارند.');
    }

    return users;
  }

  private async loadProducts(ids?: number[], label = 'محصولات') {
    const unique = this.uniqueIds(ids);

    if (!unique.length) {
      return [];
    }

    const products = await this.productRepo.find({
      where: { id: In(unique) },
    });

    if (products.length !== unique.length) {
      throw new BadRequestException(`بعضی از ${label} انتخاب‌شده وجود ندارند.`);
    }

    return products;
  }

  private async loadCategories(ids?: number[], label = 'دسته‌بندی‌ها') {
    const unique = this.uniqueIds(ids);

    if (!unique.length) {
      return [];
    }

    const categories = await this.categoryRepo.find({
      where: { id: In(unique) },
    });

    if (categories.length !== unique.length) {
      throw new BadRequestException(`بعضی از ${label} انتخاب‌شده وجود ندارند.`);
    }

    return categories;
  }

  private uniqueIds(ids?: number[]) {
    return Array.from(new Set(ids ?? []));
  }

  // =========================================================
  // USAGE COUNTS
  // =========================================================

  private async getUsedCounts(discountIds: number[]) {
    const result = new Map<number, number>();

    if (!discountIds.length) {
      return result;
    }

    const [redemptions, legacy] = await Promise.all([
      this.redemptionRepo
        .createQueryBuilder('r')
        .select('r.discount_id', 'discountId')
        .addSelect('COUNT(*)', 'count')
        .where('r.discount_id IN (:...ids)', { ids: discountIds })
        .groupBy('r.discount_id')
        .getRawMany<{ discountId: number | string; count: number | string }>(),
      this.usageRepo
        .createQueryBuilder('u')
        .select('u.discount_id', 'discountId')
        .addSelect('COUNT(*)', 'count')
        .where('u.discount_id IN (:...ids)', { ids: discountIds })
        .groupBy('u.discount_id')
        .getRawMany<{ discountId: number | string; count: number | string }>(),
    ]);

    for (const row of [...redemptions, ...legacy]) {
      const id = Number(row.discountId);
      result.set(id, (result.get(id) ?? 0) + Number(row.count));
    }

    return result;
  }

  private async countUsage(
    manager: EntityManager | null,
    discountId: number,
    userId?: number,
  ) {
    const redemptionRepo = manager
      ? manager.getRepository(DiscountRedemption)
      : this.redemptionRepo;
    const usageRepo = manager
      ? manager.getRepository(DiscountUsage)
      : this.usageRepo;

    const where = userId
      ? { discount: { id: discountId }, user: { id: userId } }
      : { discount: { id: discountId } };

    const [redemptions, legacy] = await Promise.all([
      redemptionRepo.count({ where }),
      usageRepo.count({ where }),
    ]);

    return redemptions + legacy;
  }

  private assertUsageLimits(
    discount: Discount,
    usedByUser: number,
    usedTotal: number,
  ) {
    if (
      discount.maxUsesPerUser !== null &&
      discount.maxUsesPerUser !== undefined &&
      usedByUser >= discount.maxUsesPerUser
    ) {
      throw new BadRequestException(
        discount.maxUsesPerUser === 1
          ? 'این کد تخفیف را قبلاً استفاده کرده‌اید.'
          : `شما حداکثر ${discount.maxUsesPerUser} بار می‌توانید از این کد استفاده کنید و سقف استفادهٔ شما تمام شده است.`,
      );
    }

    if (
      discount.maxTotalUses !== null &&
      discount.maxTotalUses !== undefined &&
      usedTotal >= discount.maxTotalUses
    ) {
      throw new BadRequestException(
        'ظرفیت استفاده از این کد تخفیف به پایان رسیده است.',
      );
    }
  }

  // =========================================================
  // FIND DISCOUNT BY CODE
  // =========================================================

  async findByCode(code: string) {
    const discount = await this.discountRepo.findOne({
      where: {
        code: code.trim().toUpperCase(),
        kind: DiscountKind.CODE,
      },
      relations: {
        users: true,
        categories: true,
        products: true,
        excludedProducts: true,
        excludedCategories: true,
      },
    });

    if (!discount) {
      throw new BadRequestException('کد تخفیف معتبر نیست.');
    }

    return discount;
  }

  // =========================================================
  // SURVEY / OPENING special codes
  // =========================================================

  private isSurveyDiscount(code: string): boolean {
    return code.trim().toUpperCase().startsWith(SURVEY_DISCOUNT_CODE_PREFIX);
  }

  private isOpeningDiscount(code: string): boolean {
    return code.trim().toUpperCase() === OPENING_DISCOUNT_CODE;
  }

  private async getHardcodedExcludedCategoryIds(
    code: string,
  ): Promise<Set<number>> {
    if (!this.isSurveyDiscount(code) && !this.isOpeningDiscount(code)) {
      return new Set<number>();
    }

    const result = await this.expandCategoryIds(
      HARDCODED_EXCLUDED_CATEGORY_ROOT_IDS,
    );

    if (this.isOpeningDiscount(code)) {
      for (const id of OPENING_EXCLUDED_CATEGORY_IDS) {
        result.add(id);
      }
    }

    return result;
  }

  // =========================================================
  // CATEGORY TREE
  // =========================================================

  private async getChildrenByParentId() {
    const cached = this.categoryTreeCache;

    if (cached && Date.now() - cached.cachedAt < CATEGORY_TREE_CACHE_TTL_MS) {
      return cached.childrenByParentId;
    }
    const allCategories = await this.categoryRepo.find({
      select: {
        id: true,
        parentId: true,
      },
    });

    // parentId در entity از نوع string است (نه number).
    const childrenByParentId = new Map<string, number[]>();

    for (const cat of allCategories) {
      if (cat.parentId !== null && cat.parentId !== undefined) {
        const key = String(cat.parentId);

        if (!childrenByParentId.has(key)) {
          childrenByParentId.set(key, []);
        }

        childrenByParentId.get(key)!.push(cat.id);
      }
    }

    this.categoryTreeCache = { childrenByParentId, cachedAt: Date.now() };

    return childrenByParentId;
  }

  /**
   * دسته‌های داده‌شده + همهٔ زیرمجموعه‌هایشان
   */
  async expandCategoryIds(rootIds: readonly number[]): Promise<Set<number>> {
    const result = new Set<number>();

    if (!rootIds.length) {
      return result;
    }

    const childrenByParentId = await this.getChildrenByParentId();

    const queue: number[] = [...rootIds];

    while (queue.length) {
      const current = queue.shift()!;

      if (result.has(current)) {
        continue;
      }

      result.add(current);

      for (const child of childrenByParentId.get(String(current)) ?? []) {
        queue.push(child);
      }
    }

    return result;
  }

  // =========================================================
  // CALCULATE DISCOUNT
  // =========================================================

  private calculateDiscountAmount(discount: Discount, amount: number) {
    let discountAmount = 0;

    if (discount.type === DiscountType.PERCENTAGE) {
      discountAmount = (amount * Number(discount.value)) / 100;
    }

    if (discount.type === DiscountType.FIXED) {
      discountAmount = Number(discount.value);
    }

    if (discount.maxDiscountAmount) {
      discountAmount = Math.min(
        discountAmount,
        Number(discount.maxDiscountAmount),
      );
    }

    discountAmount = Math.min(discountAmount, amount);

    return Math.max(0, discountAmount);
  }

  calculateProductDiscount(discount: Discount, originalPrice: number) {
    const discountAmount = this.calculateDiscountAmount(
      discount,
      originalPrice,
    );

    return {
      originalPrice,
      discountAmount,
      finalPrice: originalPrice - discountAmount,
    };
  }

  // =========================================================
  // SALES (فروش ویژه)
  // =========================================================

  invalidateSalesCache() {
    this.salesCache = null;
  }

  /**
   * فروش‌های ویژهٔ فعال در این لحظه
   * (فعال بودن + بازهٔ تاریخ؛ فروش‌ها عمومی هستند و به کاربر خاص وابسته نیستند)
   */
  async getActiveSales(): Promise<ActiveSale[]> {
    const now = new Date();

    let cache = this.salesCache;

    if (!cache || Date.now() - cache.cachedAt > SALES_CACHE_TTL_MS) {
      const rows = await this.discountRepo
        .createQueryBuilder('discount')
        .leftJoinAndSelect('discount.products', 'product')
        .leftJoinAndSelect('discount.categories', 'category')
        .where('discount.kind = :kind', { kind: DiscountKind.SALE })
        .andWhere('discount.isActive = :isActive', { isActive: true })
        .andWhere('discount.expiresAt >= :now', { now })
        .andWhere(qb => {
          const subQuery = qb
            .subQuery()
            .select('1')
            .from('discount_users', 'du')
            .where('du.discount_id = discount.id')
            .getQuery();

          return `NOT EXISTS ${subQuery}`;
        })
        .getMany();

      const sales: ActiveSale[] = [];

      for (const row of rows) {
        const scopeCategoryIds = await this.expandCategoryIds(
          (row.categories ?? []).map(category => category.id),
        );

        sales.push(Object.assign(row, { scopeCategoryIds }));
      }

      cache = { sales, cachedAt: Date.now() };
      this.salesCache = cache;
    }

    return cache.sales.filter(
      sale => sale.startsAt <= now && sale.expiresAt >= now,
    );
  }

  isSaleApplicable(
    sale: ActiveSale,
    productId: number,
    categoryIds: number[],
  ): boolean {
    if ((sale.products ?? []).some(product => product.id === productId)) {
      return true;
    }

    return categoryIds.some(id => sale.scopeCategoryIds.has(id));
  }

  pickBestSale(
    sales: ActiveSale[],
    productId: number,
    categoryIds: number[],
    originalPrice: number,
  ): SaleResult | null {
    let best: SaleResult | null = null;

    for (const sale of sales) {
      if (!this.isSaleApplicable(sale, productId, categoryIds)) {
        continue;
      }

      const discountAmount = this.calculateDiscountAmount(sale, originalPrice);

      if (discountAmount <= 0) {
        continue;
      }

      if (!best || discountAmount > best.discountAmount) {
        best = {
          discount: sale,
          discountAmount,
          finalPrice: Math.max(0, originalPrice - discountAmount),
        };
      }
    }

    return best;
  }

  async getBestDiscountForProduct(
    productId: number,
    categoryIds: number[],
    originalPrice: number,
  ): Promise<SaleResult | null> {
    const sales = await this.getActiveSales();

    return this.pickBestSale(sales, productId, categoryIds, originalPrice);
  }

  /**
   * (برای ترب) فروش‌های ویژهٔ فعال
   */
  async getActiveDiscountsForProducts(productIds: number[]) {
    if (!productIds.length) {
      return [];
    }

    return this.getActiveSales();
  }

  /**
   * محصولات و دسته‌های (با زیرمجموعه) مشمول فروش‌های ویژهٔ فعال؛
   * برای ساخت لیست صفحهٔ «فروش ویژه».
   */
  async getActiveSaleScope() {
    const sales = await this.getActiveSales();

    const productIds = new Set<number>();
    const categoryIds = new Set<number>();

    for (const sale of sales) {
      for (const product of sale.products ?? []) {
        productIds.add(product.id);
      }

      for (const id of sale.scopeCategoryIds) {
        categoryIds.add(id);
      }
    }

    return {
      productIds: Array.from(productIds),
      categoryIds: Array.from(categoryIds),
    };
  }

  /**
   * قیمت‌گذاری اقلام سبد با فروش ویژه. خروجی مبنای محاسبهٔ کد تخفیف و سفارش است.
   */
  async priceCartLines(lines: CartLineInput[]): Promise<PricedCartLine[]> {
    const sales = await this.getActiveSales();

    return lines.map(line => {
      const originalPrice = Number(line.price);

      const best = this.pickBestSale(
        sales,
        line.productId,
        line.categoryIds,
        originalPrice,
      );

      return {
        ...line,
        originalPrice,
        unitPrice: best ? best.finalPrice : originalPrice,
        saleDiscountPerUnit: best ? best.discountAmount : 0,
        isOnSale: !!best,
        sale: best?.discount ?? null,
      };
    });
  }

  // =========================================================
  // CODE: VALIDATE
  // =========================================================

  async validateDiscount(
    code: string,
    userId: number,
    items: CodeEligibleLine[],
  ) {
    const discount = await this.findByCode(code);

    const now = new Date();

    // =====================================================
    // 1. فعال بودن
    // =====================================================

    if (!discount.isActive) {
      throw new BadRequestException('این کد تخفیف فعال نیست.');
    }

    // =====================================================
    // 2. تاریخ اعتبار
    // =====================================================

    if (now < discount.startsAt) {
      throw new BadRequestException(
        'زمان استفاده از این کد تخفیف هنوز شروع نشده است.',
      );
    }

    if (now > discount.expiresAt) {
      throw new BadRequestException(
        'زمان استفاده از این کد تخفیف به پایان رسیده است.',
      );
    }

    if (discount.products?.length > 0 || discount.categories?.length > 0) {
      throw new BadRequestException('این کد تخفیف فعال نیست.');
    }

    // =====================================================
    // 3. محدودیت کاربر
    // =====================================================

    if (discount.users?.length > 0) {
      const userAllowed = discount.users.some(user => user.id === userId);

      if (!userAllowed) {
        throw new BadRequestException(
          'این کد تخفیف برای شما قابل استفاده نیست.',
        );
      }
    }

    // =====================================================
    // 4. سقف دفعات استفاده
    // =====================================================

    const [usedByUser, usedTotal] = await Promise.all([
      this.countUsage(null, discount.id, userId),
      discount.maxTotalUses !== null && discount.maxTotalUses !== undefined
        ? this.countUsage(null, discount.id)
        : Promise.resolve(0),
    ]);

    this.assertUsageLimits(discount, usedByUser, usedTotal);

    // =====================================================
    // 5. اقلام مشمول (حذف استثناها)
    // =====================================================

    const excludedCategoryIds = await this.getHardcodedExcludedCategoryIds(
      discount.code ?? '',
    );

    for (const id of await this.expandCategoryIds(
      (discount.excludedCategories ?? []).map(category => category.id),
    )) {
      excludedCategoryIds.add(id);
    }

    const excludedProductIds = new Set(
      (discount.excludedProducts ?? []).map(product => product.id),
    );

    const eligibleItems = items.filter(item => {
      if (excludedProductIds.has(item.productId)) {
        return false;
      }

      if (item.categoryIds.some(id => excludedCategoryIds.has(id))) {
        return false;
      }

      if (discount.excludeSaleItems && item.isOnSale) {
        return false;
      }

      return true;
    });

    if (eligibleItems.length === 0) {
      throw new BadRequestException(
        'این کد تخفیف شامل محصولات سبد خرید شما نمی‌شود.',
      );
    }

    const eligibleAmount = eligibleItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    // =====================================================
    // 6. حداقل مبلغ
    // =====================================================

    if (
      discount.minOrderAmount !== null &&
      eligibleAmount < Number(discount.minOrderAmount)
    ) {
      throw new BadRequestException(
        `حداقل مبلغ سفارش (پس از حذف محصولات مستثنا) برای استفاده از این کد ${Number(
          discount.minOrderAmount,
        ).toLocaleString()} تومان است.`,
      );
    }

    // =====================================================
    // 7. محاسبه تخفیف
    // =====================================================

    const discountAmount = this.calculateDiscountAmount(
      discount,
      eligibleAmount,
    );

    return {
      discount,
      discountAmount,
      eligibleAmount,
    };
  }

  // =========================================================
  // CODE: REDEEM (داخل تراکنش پرداخت)
  // =========================================================

  async redeemInTransaction(
    manager: EntityManager,
    params: {
      discountId?: number | null;
      code?: string | null;
      userId: number;
      orderId: number;
    },
  ) {
    const discount = await manager.findOne(Discount, {
      where: params.discountId
        ? { id: params.discountId }
        : { code: (params.code ?? '').trim().toUpperCase() },
      lock: { mode: 'pessimistic_write' },
    });

    if (!discount) {
      throw new BadRequestException('کد تخفیف سفارش یافت نشد');
    }

    const redemptionRepo = manager.getRepository(DiscountRedemption);

    const alreadyForOrder = await redemptionRepo.findOne({
      where: {
        discount: { id: discount.id },
        order: { id: params.orderId },
      },
    });

    if (alreadyForOrder) {
      return alreadyForOrder;
    }

    const [usedByUser, usedTotal] = await Promise.all([
      this.countUsage(manager, discount.id, params.userId),
      this.countUsage(manager, discount.id),
    ]);

    this.assertUsageLimits(discount, usedByUser, usedTotal);

    const redemption = redemptionRepo.create({
      discount: { id: discount.id } as Discount,
      user: { id: params.userId } as User,
      order: { id: params.orderId } as DiscountRedemption['order'],
    });

    return redemptionRepo.save(redemption);
  }

  // =========================================================
  // CART
  // =========================================================

  private async loadCartLines(userId: number): Promise<CartLineInput[]> {
    const cart = await this.cartRepo.findOne({
      where: {
        user: {
          id: userId,
        },
      },
      relations: {
        items: {
          variant: {
            product: {
              categories: true,
            },
          },
        },
      },
    });

    if (!cart || !cart.items?.length) {
      throw new BadRequestException('سبد خرید خالی است.');
    }

    return cart.items.map(item => ({
      productId: item.variant.product.id,
      quantity: item.quantity,
      price: Number(item.variant.price),
      categoryIds:
        item.variant.product.categories?.map(category => category.id) ?? [],
    }));
  }

  async applyDiscountToCart(userId: number, code: string) {
    const lines = await this.loadCartLines(userId);

    const priced = await this.priceCartLines(lines);

    const originalPrice = priced.reduce(
      (sum, line) => sum + line.originalPrice * line.quantity,
      0,
    );

    const saleDiscount = priced.reduce(
      (sum, line) => sum + line.saleDiscountPerUnit * line.quantity,
      0,
    );

    const result = await this.validateDiscount(
      code.trim().toUpperCase(),
      userId,
      priced.map(line => ({
        productId: line.productId,
        quantity: line.quantity,
        price: line.unitPrice,
        categoryIds: line.categoryIds,
        isOnSale: line.isOnSale,
      })),
    );

    const codeDiscount = Number(result.discountAmount);

    const discountPrice = saleDiscount + codeDiscount;

    return {
      discount: {
        id: result.discount.id,
        code: result.discount.code,
        type: result.discount.type,
        value: Number(result.discount.value),
      },

      summary: {
        originalPrice,
        saleDiscountPrice: saleDiscount,
        codeDiscountPrice: codeDiscount,
        discountPrice,
        finalPrice: Math.max(0, originalPrice - discountPrice),
      },
    };
  }
}
