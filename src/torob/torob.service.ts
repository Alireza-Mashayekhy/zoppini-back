import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Category } from 'src/categories/entities/category.entity';
import { ActiveSale, DiscountService } from 'src/discounts/discounts.service';
import { Product } from 'src/products/entities/product.entity';
import { ProductColorImage } from 'src/products/entities/product-color-image.entity';
import { Variant } from 'src/products/entities/variant.entity';
import { In, Repository, SelectQueryBuilder } from 'typeorm';

import {
  TOROB_API_VERSION,
  TOROB_PAGE_SIZE,
  TorobCursor,
  TorobPageSort,
  TorobProduct,
  TorobResponse,
} from './interfaces/torob-api.interface';
import { TorobApiException } from './torob-api.exception';
import { encodeCursor, parseTorobRequest } from './torob-request.parser';

/**
 * شکل خام ردیف‌های کوئری صفحه‌بندی.
 *
 * نکته مهم درباره تاریخ‌ها: مقادیر تاریخ به صورت رشته‌ی «ساعت دیواری» از دیتابیس
 * خوانده می‌شوند (نه به عنوان شیء Date) تا دقیقاً همان رقم‌هایی که در پنل و
 * سایت نمایش داده می‌شود به ترب هم برسد و درگیری timezone سمت دیتابیس/سرور
 * وارد بازی نشود.
 */
interface VariantRow {
  variantId: string | number;
  variantPrice: string | number;
  variantStock: string | number;
  colorId: string | number;
  colorName: string;
  sizeId: string | number;
  sizeName: string;
  productId: string | number;
  productCode: string;
  productTitle: string;
  productSlug: string;
  productImage: string | null;
  productDescription: string | null;
  dateAdded: string;
  dateUpdated: string;
}

interface CategoryLinkRow {
  productId: string | number;
  categoryId: string | number;
}

interface BuildContext {
  discounts: ActiveSale[];
  categoryIdsByProduct: Map<number, number[]>;
  categoryNameById: Map<number, string>;
  categoryDepthById: Map<number, number>;
  imagesByProduct: Map<number, ProductColorImage[]>;
  imagesByProductColor: Map<string, ProductColorImage[]>;
}

/** آدرس صفحه محصول در سایت با این پیشوند شروع می‌شود */
const PRODUCT_PATH_PREFIX = '/product/';

/** timezone ایران: +03:30 (ساعت تابستانی از سال ۱۴۰۱ حذف شده است) */
const TEHRAN_TIMEZONE_SUFFIX = '+03:30';

interface PageUrlTarget {
  slug: string;
  variantId?: number;
  colorId?: number;
  sizeId?: number;
}

@Injectable()
export class TorobService {
  private readonly logger = new Logger(TorobService.name);

  private readonly siteUrl: string;
  private readonly imageBaseUrl: string;
  private readonly guarantee: string | null;
  private readonly includeOutOfStock: boolean;

  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
    @InjectRepository(Variant)
    private readonly variantRepo: Repository<Variant>,
    @InjectRepository(ProductColorImage)
    private readonly colorImageRepo: Repository<ProductColorImage>,
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
    private readonly configService: ConfigService,
    private readonly discountsService: DiscountService,
  ) {
    this.siteUrl = this.normalizeBaseUrl(
      this.configService.get<string>('TOROB_SITE_URL') ||
        this.configService.get<string>('SITE_URL') ||
        'https://zoppinico.com',
    );

    this.imageBaseUrl = this.normalizeBaseUrl(
      this.configService.get<string>('TOROB_IMAGE_BASE_URL') || this.siteUrl,
    );

    const guarantee = this.configService.get<string>('TOROB_GUARANTEE')?.trim();

    this.guarantee = guarantee ? this.truncate(guarantee, 200) : null;

    this.includeOutOfStock =
      this.configService.get<string>('TOROB_INCLUDE_OUT_OF_STOCK') !== 'false';
  }

  // =========================================================
  // PUBLIC ENTRY POINT
  // =========================================================

  async handleRequest(body: unknown): Promise<TorobResponse> {
    const request = parseTorobRequest(body);

    this.logger.debug(
      `torob request: mode=${request.mode}${
        request.page ? ` page=${request.page}` : ''
      }${request.sort ? ` sort=${request.sort}` : ''}`,
    );

    switch (request.mode) {
      case 'page':
        return this.listByPage(
          request.page as number,
          request.sort as TorobPageSort,
        );
      case 'cursor':
        return this.listByCursor(request.cursor as TorobCursor);
      case 'page_uniques':
        return this.getByUniques(request.pageUniques as string[]);
      case 'page_urls':
        return this.getByUrls(request.pageUrls as string[]);
      default:
        throw TorobApiException.badRequest('unsupported request mode');
    }
  }

  // =========================================================
  // LIST / PAGINATION
  // =========================================================

  private async listByPage(
    page: number,
    sort: TorobPageSort,
  ): Promise<TorobResponse> {
    const total = await this.countEligibleVariants();

    const query = this.createEligibleVariantQuery();

    this.applySelection(query);
    this.applySort(query, sort);

    // توجه: چون کوئری JOIN دارد، در TypeORM باید از limit/offset استفاده شود
    // (skip/take در کوئری‌های دارای join نادیده گرفته می‌شوند).
    query.limit(TOROB_PAGE_SIZE).offset((page - 1) * TOROB_PAGE_SIZE);

    const rows = await query.getRawMany<VariantRow>();

    return {
      api_version: TOROB_API_VERSION,
      current_page: page,
      total,
      max_pages: Math.max(1, Math.ceil(total / TOROB_PAGE_SIZE)),
      next_cursor: null,
      products: await this.buildProducts(rows),
    };
  }

  private async listByCursor(cursor: TorobCursor): Promise<TorobResponse> {
    const query = this.createEligibleVariantQuery();

    if (cursor.lastVariantId > 0) {
      query.andWhere('variant.id < :cursorId', {
        cursorId: cursor.lastVariantId,
      });
    }

    this.applySelection(query);

    // یک رکورد بیشتر گرفته می‌شود تا بفهمیم صفحه‌ی بعدی وجود دارد یا نه
    query.orderBy('variant.id', 'DESC').limit(TOROB_PAGE_SIZE + 1);

    const rows = await query.getRawMany<VariantRow>();

    const hasMore = rows.length > TOROB_PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, TOROB_PAGE_SIZE) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      api_version: TOROB_API_VERSION,
      current_page: cursor.page,
      total: null,
      max_pages: null,
      next_cursor:
        hasMore && lastRow
          ? encodeCursor({
              lastVariantId: Number(lastRow.variantId),
              page: cursor.page + 1,
            })
          : null,
      products: await this.buildProducts(pageRows),
    };
  }

  // =========================================================
  // SINGLE / BATCH LOOKUP
  // =========================================================

  private async getByUniques(pageUniques: string[]): Promise<TorobResponse> {
    const query = this.createEligibleVariantQuery();

    this.applySelection(query);

    // page_unique به شکل `{productCode}-{colorId}-{sizeId}` ساخته می‌شود
    query
      .andWhere(
        `CONCAT(product.productCode, '-', variant.color_id, '-', variant.size_id) IN (:...pageUniques)`,
        { pageUniques },
      )
      .orderBy('product.productCode', 'ASC')
      .addOrderBy('variant.color_id', 'ASC')
      .addOrderBy('variant.size_id', 'ASC');

    const rows = await query.getRawMany<VariantRow>();

    return this.buildLookupResponse(rows);
  }

  private async getByUrls(pageUrls: string[]): Promise<TorobResponse> {
    const targets = pageUrls.map(url => this.parsePageUrl(url));
    const slugs = [...new Set(targets.map(target => target.slug))];

    const products = await this.productRepo.find({
      where: { slug: In(slugs) },
      select: { id: true, slug: true },
    });

    const productIdBySlug = new Map(
      products.map(product => [product.slug, product.id]),
    );

    // محصولاتی که slug آن‌ها پیدا نشد حذف شده‌اند و نباید در خروجی بیایند
    if (!productIdBySlug.size) {
      return this.buildLookupResponse([]);
    }

    const rows = await this.resolveRowsForTargets(targets, productIdBySlug);

    return this.buildLookupResponse(rows);
  }

  /**
   * برای هر لینک درخواستی، واریانت متناظر را پیدا می‌کند.
   *
   * اولویت: `?variant=<variantId>` سپس `?color=<id>&size=<id>` و در نهایت
   * اولین واریانت موجود محصول.
   */
  private async resolveRowsForTargets(
    targets: PageUrlTarget[],
    productIdBySlug: Map<string, number>,
  ): Promise<VariantRow[]> {
    const explicitVariantIds = new Set<number>();
    const productIdsNeedingDefault = new Set<number>();
    const defaultVariantIdByProduct = new Map<number, number>();
    const filterByColorOrSize: {
      productId: number;
      colorId?: number;
      sizeId?: number;
    }[] = [];

    for (const target of targets) {
      const productId = productIdBySlug.get(target.slug);

      if (!productId) {
        continue;
      }

      if (target.variantId) {
        explicitVariantIds.add(target.variantId);
      } else if (target.colorId || target.sizeId) {
        filterByColorOrSize.push({
          productId,
          colorId: target.colorId,
          sizeId: target.sizeId,
        });
      } else {
        productIdsNeedingDefault.add(productId);
      }
    }

    const rowsByVariantId = new Map<number, VariantRow>();

    const loadRows = async (variantIds: number[]) => {
      if (!variantIds.length) {
        return;
      }

      const query = this.createEligibleVariantQuery();

      this.applySelection(query);

      query.andWhere('variant.id IN (:...variantIds)', { variantIds });

      const rows = await query.getRawMany<VariantRow>();

      for (const row of rows) {
        rowsByVariantId.set(Number(row.variantId), row);
      }
    };

    await loadRows([...explicitVariantIds]);

    // حالت color/size: نزدیک‌ترین واریانت به فیلتر داده‌شده
    if (filterByColorOrSize.length) {
      const variantIds =
        await this.findVariantIdsByColorOrSize(filterByColorOrSize);

      await loadRows(variantIds);
    }

    // حالت پیش‌فرض: اولین واریانت موجود، وگرنه اولین واریانت
    if (productIdsNeedingDefault.size) {
      const defaultVariants = await this.findDefaultVariants([
        ...productIdsNeedingDefault,
      ]);

      for (const [productId, variantId] of defaultVariants) {
        defaultVariantIdByProduct.set(productId, variantId);
      }

      await loadRows([...defaultVariants.values()]);
    }

    const orderedRows: VariantRow[] = [];

    for (const target of targets) {
      const productId = productIdBySlug.get(target.slug);

      if (!productId) {
        continue;
      }

      if (target.variantId) {
        // اگر تنوع درخواستی حذف/ناموجود شده باشد، نباید چیز دیگری جای آن برگردد
        const row = rowsByVariantId.get(target.variantId);

        if (row && Number(row.productId) === productId) {
          orderedRows.push(row);
        }

        continue;
      }

      const colorOrSizeTarget = filterByColorOrSize.find(
        item => item.productId === productId,
      );

      if (colorOrSizeTarget) {
        const row = this.pickRowForColorOrSize(
          productId,
          colorOrSizeTarget,
          rowsByVariantId,
        );

        if (row) {
          orderedRows.push(row);
        }

        continue;
      }

      const defaultRow = rowsByVariantId.get(
        defaultVariantIdByProduct.get(productId) ?? -1,
      );

      if (defaultRow) {
        orderedRows.push(defaultRow);
      }
    }

    return orderedRows;
  }

  private async findDefaultVariants(
    productIds: number[],
  ): Promise<Map<number, number>> {
    const result = new Map<number, number>();

    if (!productIds.length) {
      return result;
    }

    const rows = await this.variantRepo
      .createQueryBuilder('variant')
      .select('variant.product_id', 'productId')
      .addSelect('variant.id', 'variantId')
      .where('variant.product_id IN (:...productIds)', { productIds })
      .orderBy('(variant.stock > 0)', 'DESC')
      .addOrderBy('variant.id', 'ASC')
      .getRawMany<{ productId: string; variantId: string }>();

    const variantIds: number[] = [];

    for (const row of rows) {
      const productId = Number(row.productId);

      if (result.has(productId)) {
        continue;
      }

      result.set(productId, Number(row.variantId));
      variantIds.push(Number(row.variantId));
    }

    return result;
  }

  private async findVariantIdsByColorOrSize(
    filters: { productId: number; colorId?: number; sizeId?: number }[],
  ): Promise<number[]> {
    const productIds = [...new Set(filters.map(filter => filter.productId))];

    if (!productIds.length) {
      return [];
    }

    const rows = await this.variantRepo
      .createQueryBuilder('variant')
      .select('variant.id', 'variantId')
      .addSelect('variant.product_id', 'productId')
      .addSelect('variant.color_id', 'colorId')
      .addSelect('variant.size_id', 'sizeId')
      .addSelect('variant.stock', 'stock')
      .where('variant.product_id IN (:...productIds)', { productIds })
      .orderBy('(variant.stock > 0)', 'DESC')
      .addOrderBy('variant.id', 'ASC')
      .getRawMany<{
        variantId: string;
        productId: string;
        colorId: string;
        sizeId: string;
        stock: string;
      }>();

    const firstMatchByProduct = new Map<number, number>();

    for (const row of rows) {
      const productId = Number(row.productId);

      if (firstMatchByProduct.has(productId)) {
        continue;
      }

      const matches = filters.some(
        filter =>
          filter.productId === productId &&
          (filter.colorId === undefined ||
            filter.colorId === Number(row.colorId)) &&
          (filter.sizeId === undefined || filter.sizeId === Number(row.sizeId)),
      );

      if (matches) {
        firstMatchByProduct.set(productId, Number(row.variantId));
      }
    }

    return [...firstMatchByProduct.values()];
  }

  private pickRowForColorOrSize(
    productId: number,
    target: { colorId?: number; sizeId?: number },
    rowsByVariantId: Map<number, VariantRow>,
  ): VariantRow | null {
    for (const row of rowsByVariantId.values()) {
      if (
        Number(row.productId) !== productId ||
        (target.colorId !== undefined &&
          Number(row.colorId) !== target.colorId) ||
        (target.sizeId !== undefined && Number(row.sizeId) !== target.sizeId)
      ) {
        continue;
      }

      // rowsByVariantId به ترتیب اولویت (موجود بودن اول) پر شده است
      return row;
    }

    return null;
  }

  private async buildLookupResponse(
    rows: VariantRow[],
  ): Promise<TorobResponse> {
    return {
      api_version: TOROB_API_VERSION,
      current_page: 1,
      total: rows.length,
      max_pages: 1,
      next_cursor: null,
      products: rows.length ? await this.buildProducts(rows) : [],
    };
  }

  // =========================================================
  // URL PARSING
  // =========================================================

  private parsePageUrl(raw: string): PageUrlTarget {
    let url: URL;

    try {
      url = new URL(raw);
    } catch {
      throw TorobApiException.badRequest(
        `page_urls must contain absolute urls, invalid url: ${raw}`,
      );
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw TorobApiException.badRequest(
        `page_urls must contain http(s) urls, invalid url: ${raw}`,
      );
    }

    const normalizedPath = url.pathname.replace(/\/+$/, '');

    if (!normalizedPath.startsWith(PRODUCT_PATH_PREFIX)) {
      throw TorobApiException.badRequest(
        `page_urls must contain product page urls (${PRODUCT_PATH_PREFIX}<slug>), invalid url: ${raw}`,
      );
    }

    const slugPart = normalizedPath.slice(PRODUCT_PATH_PREFIX.length);

    if (!slugPart || slugPart.includes('/')) {
      throw TorobApiException.badRequest(
        `page_urls must contain product page urls (${PRODUCT_PATH_PREFIX}<slug>), invalid url: ${raw}`,
      );
    }

    let slug: string;

    try {
      slug = decodeURIComponent(slugPart);
    } catch {
      throw TorobApiException.badRequest(
        `page_urls contains an url with an invalid slug: ${raw}`,
      );
    }

    return {
      slug,
      variantId: this.readIntParam(url, ['variant', 'v']),
      colorId: this.readIntParam(url, ['color']),
      sizeId: this.readIntParam(url, ['size']),
    };
  }

  private readIntParam(url: URL, names: string[]): number | undefined {
    for (const name of names) {
      const value = url.searchParams.get(name);

      if (value === null) {
        continue;
      }

      const parsed = Number(value);

      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return undefined;
  }

  // =========================================================
  // QUERY BUILDERS
  // =========================================================

  /**
   * کوئری پایه‌ی واریانت‌های قابل انتشار در ترب.
   *
   * یک محصول زمانی منتشر می‌شود که:
   *  - حداقل یک دسته‌بندی فعال داشته باشد (برای دسته‌بندی در ترب)
   *  - حداقل یک تصویر داشته باشد (`image_links` اجباری است)
   *  - قیمت واریانت بزرگ‌تر از صفر باشد (تا محصول رایگان اشتباه ثبت نشود)
   *
   * توجه: به جای JOIN از EXISTS استفاده شده تا ردیف‌ها تکراری نشوند و
   * صفحه‌بندی (total / max_pages) دقیق بماند.
   */
  private createEligibleVariantQuery(): SelectQueryBuilder<Variant> {
    const query = this.variantRepo
      .createQueryBuilder('variant')
      .innerJoin('variant.product', 'product')
      .innerJoin('variant.color', 'color')
      .innerJoin('variant.size', 'size')
      .where('variant.price > 0').andWhere(`EXISTS (
        SELECT 1
        FROM product_categories pc
        INNER JOIN category c ON c.id = pc.category_id
        WHERE pc.product_id = product.id AND c.isActive = 1
      )`).andWhere(`(
        (product.image IS NOT NULL AND product.image <> '')
        OR EXISTS (
          SELECT 1 FROM product_color_image pci WHERE pci.product_id = product.id
        )
      )`);

    if (!this.includeOutOfStock) {
      query.andWhere('variant.stock > 0');
    }

    return query;
  }

  private applySelection(
    query: SelectQueryBuilder<Variant>,
  ): SelectQueryBuilder<Variant> {
    return query
      .select('variant.id', 'variantId')
      .addSelect('variant.price', 'variantPrice')
      .addSelect('variant.stock', 'variantStock')
      .addSelect('variant.color_id', 'colorId')
      .addSelect('color.name', 'colorName')
      .addSelect('variant.size_id', 'sizeId')
      .addSelect('size.name', 'sizeName')
      .addSelect('product.id', 'productId')
      .addSelect('product.productCode', 'productCode')
      .addSelect('product.title', 'productTitle')
      .addSelect('product.slug', 'productSlug')
      .addSelect('product.image', 'productImage')
      .addSelect('product.description', 'productDescription')
      .addSelect(
        "DATE_FORMAT(product.createdAt, '%Y-%m-%dT%H:%i:%s')",
        'dateAdded',
      )
      .addSelect(
        "DATE_FORMAT(GREATEST(product.updatedAt, variant.updatedAt), '%Y-%m-%dT%H:%i:%s')",
        'dateUpdated',
      );
  }

  private applySort(
    query: SelectQueryBuilder<Variant>,
    sort: TorobPageSort,
  ): SelectQueryBuilder<Variant> {
    if (sort === 'date_updated_desc') {
      return query
        .orderBy('GREATEST(product.updatedAt, variant.updatedAt)', 'DESC')
        .addOrderBy('variant.id', 'ASC');
    }

    return query
      .orderBy('product.createdAt', 'DESC')
      .addOrderBy('variant.id', 'ASC');
  }

  private async countEligibleVariants(): Promise<number> {
    const rows = await this.createEligibleVariantQuery()
      .select('COUNT(DISTINCT variant.id)', 'total')
      .getRawMany<{ total: string | number }>();

    return Number(rows[0]?.total ?? 0);
  }

  // =========================================================
  // PAYLOAD BUILDING
  // =========================================================

  private async buildProducts(rows: VariantRow[]): Promise<TorobProduct[]> {
    if (!rows.length) {
      return [];
    }

    const context = await this.loadContext(rows);

    return rows.map(row => this.buildProduct(row, context));
  }

  private async loadContext(rows: VariantRow[]): Promise<BuildContext> {
    const productIds = [...new Set(rows.map(row => Number(row.productId)))];

    const [colorImages, categoryLinks, categoryTree, discounts] =
      await Promise.all([
        this.loadColorImages(productIds),
        this.loadCategoryLinks(productIds),
        this.loadCategoryTree(),
        this.discountsService.getActiveDiscountsForProducts(productIds),
      ]);

    const imagesByProduct = new Map<number, ProductColorImage[]>();
    const imagesByProductColor = new Map<string, ProductColorImage[]>();

    for (const image of colorImages) {
      const productId = image.product?.id;

      if (!productId) {
        continue;
      }

      const productImages = imagesByProduct.get(productId) ?? [];
      productImages.push(image);
      imagesByProduct.set(productId, productImages);

      const colorKey = `${productId}:${image.color?.id ?? 'none'}`;

      const imagesOfColor = imagesByProductColor.get(colorKey) ?? [];
      imagesOfColor.push(image);
      imagesByProductColor.set(colorKey, imagesOfColor);
    }

    const categoryIdsByProduct = new Map<number, number[]>();

    for (const link of categoryLinks) {
      const productId = Number(link.productId);
      const categoryId = Number(link.categoryId);

      const list = categoryIdsByProduct.get(productId) ?? [];
      list.push(categoryId);
      categoryIdsByProduct.set(productId, list);
    }

    const categoryById = new Map(
      categoryTree.map(category => [category.id, category]),
    );

    const categoryDepthById = new Map<number, number>();

    for (const category of categoryTree) {
      categoryDepthById.set(
        category.id,
        this.categoryDepth(category, categoryById),
      );
    }

    return {
      discounts,
      categoryIdsByProduct,
      categoryNameById: new Map(
        categoryTree.map(category => [category.id, category.name]),
      ),
      categoryDepthById,
      imagesByProduct,
      imagesByProductColor,
    };
  }

  private async loadColorImages(
    productIds: number[],
  ): Promise<ProductColorImage[]> {
    if (!productIds.length) {
      return [];
    }

    return this.colorImageRepo
      .createQueryBuilder('image')
      .leftJoinAndSelect('image.color', 'color')
      .innerJoin('image.product', 'product')
      .where('product.id IN (:...productIds)', { productIds })
      .orderBy('image.order', 'ASC')
      .addOrderBy('image.id', 'ASC')
      .getMany();
  }

  private async loadCategoryLinks(
    productIds: number[],
  ): Promise<CategoryLinkRow[]> {
    if (!productIds.length) {
      return [];
    }

    return this.categoryRepo
      .createQueryBuilder('category')
      .innerJoin('category.products', 'product')
      .where('product.id IN (:...productIds)', { productIds })
      .andWhere('category.isActive = :isActive', { isActive: true })
      .select('product.id', 'productId')
      .addSelect('category.id', 'categoryId')
      .getRawMany<CategoryLinkRow>();
  }

  /** درخت دسته‌بندی‌های فعال (جدول کوچکی است و در هر درخواست خوانده می‌شود) */
  private async loadCategoryTree(): Promise<Category[]> {
    return this.categoryRepo.find({
      where: { isActive: true },
      select: { id: true, name: true, parentId: true },
    });
  }

  private categoryDepth(
    category: Category,
    byId: Map<number, Category>,
  ): number {
    let depth = 0;
    let current = category;
    const visited = new Set<number>([category.id]);

    while (current.parentId) {
      const parentId = Number(current.parentId);

      if (visited.has(parentId)) {
        break;
      }

      visited.add(parentId);
      depth += 1;

      const parent = byId.get(parentId);

      if (!parent) {
        break;
      }

      current = parent;
    }

    return depth;
  }

  private buildProduct(row: VariantRow, context: BuildContext): TorobProduct {
    const productId = Number(row.productId);
    const colorId = Number(row.colorId);
    const sizeId = Number(row.sizeId);

    const stock = Number(row.variantStock ?? 0);
    const availability = stock > 0;

    const originalPrice = Math.max(
      0,
      Math.round(Number(row.variantPrice) || 0),
    );

    const categoryIds = context.categoryIdsByProduct.get(productId) ?? [];

    const bestDiscount = this.pickBestDiscount(
      context.discounts,
      productId,
      categoryIds,
      originalPrice,
    );

    let finalPrice = bestDiscount
      ? Math.max(0, Math.round(bestDiscount.finalPrice))
      : originalPrice;

    // محصول ناموجود بهتر است قیمت قبلی‌اش را نشان بدهد، ولی محصول موجود
    // نباید به عنوان «محصول رایگان» ثبت شود.
    if (finalPrice <= 0 && availability && originalPrice > 0) {
      finalPrice = originalPrice;
    }

    const currentPrice = Math.max(0, finalPrice);

    const oldPrice =
      bestDiscount && currentPrice > 0 && currentPrice < originalPrice
        ? originalPrice
        : null;

    const productCode = String(row.productCode ?? '').trim();

    return {
      page_unique: this.truncate(`${productCode}-${colorId}-${sizeId}`, 200),
      page_url: this.truncate(
        this.buildPageUrl(row, Number(row.variantId)),
        1500,
      ),
      title: this.truncate(String(row.productTitle ?? '').trim(), 500),
      subtitle: this.truncate(productCode, 500) || null,
      product_group_id: this.truncate(productCode, 200) || null,
      current_price: currentPrice,
      old_price: oldPrice,
      availability,
      category_name: this.resolveCategoryName(categoryIds, context),
      image_links: this.resolveImages(row, productId, colorId, context),
      short_desc: this.toShortDesc(row.productDescription),
      spec: this.buildSpec(row, colorId, sizeId),
      guarantee: this.guarantee,
      date_added: this.toIso(row.dateAdded),
      date_updated: this.toIso(row.dateUpdated),
      seller_name: null,
      seller_city: null,
    };
  }

  private pickBestDiscount(
    discounts: ActiveSale[],
    productId: number,
    categoryIds: number[],
    originalPrice: number,
  ): { discountAmount: number; finalPrice: number } | null {
    return this.discountsService.pickBestSale(
      discounts,
      productId,
      categoryIds,
      originalPrice,
    );
  }

  private buildPageUrl(row: VariantRow, variantId: number): string {
    const slug = encodeURIComponent(String(row.productSlug ?? '').trim());

    return `${this.siteUrl}${PRODUCT_PATH_PREFIX}${slug}?variant=${variantId}`;
  }

  private resolveCategoryName(
    categoryIds: number[],
    context: BuildContext,
  ): string | null {
    let bestId: number | null = null;
    let bestDepth = -1;

    for (const categoryId of categoryIds) {
      const depth = context.categoryDepthById.get(categoryId) ?? 0;

      if (
        depth > bestDepth ||
        (depth === bestDepth && bestId !== null && categoryId < bestId)
      ) {
        bestDepth = depth;
        bestId = categoryId;
      }
    }

    if (bestId === null) {
      return null;
    }

    const name = context.categoryNameById.get(bestId);

    return name ? this.truncate(name.trim(), 200) : null;
  }

  private resolveImages(
    row: VariantRow,
    productId: number,
    colorId: number,
    context: BuildContext,
  ): string[] {
    // طبق مستند ترب، تصویر هر آپشن (رنگ) باید مربوط به همان آپشن باشد
    const imagesOfColor =
      context.imagesByProductColor.get(`${productId}:${colorId}`) ?? [];

    const links: string[] = [];
    const seen = new Set<string>();

    const push = (path: string | null | undefined) => {
      const url = this.toAbsoluteUrl(path);

      if (url && !seen.has(url)) {
        seen.add(url);
        links.push(this.truncate(url, 1000));
      }
    };

    if (imagesOfColor.length) {
      for (const image of imagesOfColor) {
        push(image.url);
      }

      return links.slice(0, 20);
    }

    // تصویری برای این رنگ ثبت نشده: اول تصویر اصلی محصول (طبق الزام ترب
    // اولین تصویر گالری باید تصویر اصلی باشد) و بعد بقیه‌ی تصاویر محصول
    push(row.productImage);

    for (const image of context.imagesByProduct.get(productId) ?? []) {
      push(image.url);
    }

    return links.slice(0, 20);
  }

  private buildSpec(
    row: VariantRow,
    colorId: number,
    sizeId: number,
  ): Record<string, string | number> {
    const spec: Record<string, string | number> = {};

    const colorName = String(row.colorName ?? '').trim();

    if (colorName) {
      spec['رنگ'] = this.truncate(colorName, 100);
    }

    const sizeName = String(row.sizeName ?? '').trim();

    if (sizeName) {
      spec['سایز'] = this.truncate(sizeName, 100);
    }

    const productCode = String(row.productCode ?? '').trim();

    if (productCode) {
      spec['کد محصول'] = this.truncate(productCode, 100);
    }

    spec['شناسه رنگ'] = colorId;
    spec['شناسه سایز'] = sizeId;

    return spec;
  }

  // =========================================================
  // HELPERS
  // =========================================================

  private toAbsoluteUrl(path: string | null | undefined): string | null {
    const value = String(path ?? '').trim();

    if (!value) {
      return null;
    }

    if (/^https?:\/\//i.test(value)) {
      return value;
    }

    return `${this.imageBaseUrl}${value.startsWith('/') ? value : `/${value}`}`;
  }

  private normalizeBaseUrl(value: string): string {
    return value.trim().replace(/\/+$/, '');
  }

  private toIso(value: string | null | undefined): string {
    const text = String(value ?? '').trim();

    // تاریخ خوانده‌شده از دیتابیس به صورت `YYYY-MM-DDTHH:mm:ss` است
    const match = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);

    if (!match) {
      const now = new Date(Date.now() + 3.5 * 60 * 60 * 1000);

      return `${now.toISOString().slice(0, 19)}${TEHRAN_TIMEZONE_SUFFIX}`;
    }

    return `${match[1]}T${match[2]}${TEHRAN_TIMEZONE_SUFFIX}`;
  }

  private toShortDesc(html: string | null | undefined): string | null {
    const value = String(html ?? '').trim();

    if (!value) {
      return null;
    }

    const text = value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#3[49];/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();

    return text ? this.truncate(text, 500) : null;
  }

  private truncate(value: string, maxLength: number): string {
    const text = String(value ?? '');

    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }
}
