import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Category } from 'src/categories/entities/category.entity';
import { ActiveSale, DiscountService } from 'src/discounts/discounts.service';
import { ResolvedProductGuides } from 'src/product-guides/guide-resolution';
import { ProductGuidesService } from 'src/product-guides/product-guides.service';
import { Product } from 'src/products/entities/product.entity';
import { ProductColorImage } from 'src/products/entities/product-color-image.entity';
import { Variant } from 'src/products/entities/variant.entity';
import { In, Repository, SelectQueryBuilder } from 'typeorm';

import {
  MODAI_API_VERSION,
  MODAI_MAX_IMAGE_LINKS,
  MODAI_PAGE_SIZE,
  ModaiCategory,
  ModaiProduct,
  ModaiProductAttribute,
  ModaiResponse,
  ModaiSort,
  ModaiVariant,
  ModaiVariantAttribute,
} from './interfaces/modai-api.interface';
import {
  buildSizeGuide,
  COLOR_ATTRIBUTE_TITLE,
  htmlToPlainText,
  normalizeBaseUrl,
  SIZE_ATTRIBUTE_TITLE,
  toAbsoluteUrl,
  toTehranIso,
  truncate,
} from './modai.utils';
import {
  parseModaiRequest,
  parseModaiUniquesRequest,
} from './modai-request.parser';

/** آدرس صفحهٔ محصول در سایت با این پیشوند شروع می‌شود */
const PRODUCT_PATH_PREFIX = '/product/';

/**
 * پیشوند پیش‌فرض فایل‌های آپلودی (همان چیزی که main.ts به‌صورت static سرو می‌کند)
 */
const UPLOAD_PATH = '/uploads';

/**
 * آخرین زمان تغییر اطلاعاتی که در API منتشر می‌شود.
 *
 * تغییر قیمت/موجودی تنوع‌ها هم بخشی از اطلاعات این درگاه است، پس `date_updated`
 * باید بیشینهٔ تاریخ تغییر محصول و تنوع‌هایش باشد؛ مرتب‌سازی `date_updated_desc`
 * هم دقیقاً بر اساس همین عبارت انجام می‌شود تا با مقدار ارسالی هم‌خوان باشد.
 */
const LAST_CHANGE_EXPRESSION = `GREATEST(
  product.updatedAt,
  COALESCE(
    (
      SELECT MAX(variant_update.updatedAt)
      FROM variant variant_update
      WHERE variant_update.product_id = product.id
    ),
    product.updatedAt
  )
)`;

/** شکل خام ردیف‌های کوئری صفحه‌بندی */
interface ProductRow {
  productId: string | number;
  dateAdded: string;
  dateUpdated: string;
  /** فقط در کوئری products-by-uniques انتخاب می‌شود */
  productCode?: string;
}

@Injectable()
export class ModaiService {
  private readonly logger = new Logger(ModaiService.name);

  private readonly siteUrl: string;
  private readonly imageBaseUrl: string | null;
  private readonly includeOutOfStock: boolean;
  private readonly sendHtmlDescription: boolean;

  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,

    private readonly configService: ConfigService,
    private readonly discountsService: DiscountService,
    private readonly productGuidesService: ProductGuidesService,
  ) {
    this.siteUrl = normalizeBaseUrl(
      this.configService.get<string>('MODAI_SITE_URL') ||
        this.configService.get<string>('SITE_URL') ||
        'https://zoppinico.com',
    );

    const imageBaseUrl =
      this.configService.get<string>('MODAI_IMAGE_BASE_URL')?.trim() ||
      this.configService.get<string>('TOROB_IMAGE_BASE_URL')?.trim();

    this.imageBaseUrl = imageBaseUrl ? normalizeBaseUrl(imageBaseUrl) : null;

    this.includeOutOfStock =
      this.configService.get<string>('MODAI_INCLUDE_OUT_OF_STOCK') !== 'false';

    this.sendHtmlDescription =
      this.configService.get<string>('MODAI_SEND_HTML_DESCRIPTION') === 'true';
  }

  // =========================================================
  // PUBLIC ENTRY POINT
  // =========================================================

  async handleRequest(body: unknown): Promise<ModaiResponse> {
    const request = parseModaiRequest(body);

    if (request.unknownKeys.length) {
      this.logger.warn(
        `modai request has unsupported parameter(s): ${request.unknownKeys.join(
          ', ',
        )}`,
      );
    }

    this.logger.debug(
      `modai request: page=${request.page} sort=${request.sort}`,
    );

    return this.listByPage(request.page, request.sort);
  }

  /**
   * `POST /modai-api/v1/products-by-uniques`
   *
   * خروجی فقط شامل محصولاتی است که هنوز در فروشگاه هستند و شرایط انتشار را
   * دارند؛ محصول حذف‌شده یا مخفی در لیست نمی‌آید (طبق ملاحظهٔ ۵ مستند).
   */
  async handleProductsByUniques(body: unknown): Promise<ModaiResponse> {
    const requested = parseModaiUniquesRequest(body);

    const rows = await this.createEligibleProductQuery()
      .select('product.id', 'productId')
      .addSelect('product.productCode', 'productCode')
      .addSelect(
        "DATE_FORMAT(product.createdAt, '%Y-%m-%dT%H:%i:%s')",
        'dateAdded',
      )
      .addSelect(
        `DATE_FORMAT(${LAST_CHANGE_EXPRESSION}, '%Y-%m-%dT%H:%i:%s')`,
        'dateUpdated',
      )
      .andWhere('product.productCode IN (:...requested)', { requested })
      .getRawMany<ProductRow>();

    // ترتیب خروجی همان ترتیب درخواست مدآی است
    const rowByCode = new Map(
      rows.map(row => [String(row.productCode ?? ''), row]),
    );

    const orderedRows = requested
      .map(code => rowByCode.get(code))
      .filter((row): row is ProductRow => Boolean(row));

    this.logger.debug(
      `modai products-by-uniques: requested=${requested.length} found=${orderedRows.length}`,
    );

    return {
      api_version: MODAI_API_VERSION,
      current_page: 1,
      total: orderedRows.length,
      max_pages: 1,
      products: await this.buildProductsFromRows(orderedRows),
    };
  }

  // =========================================================
  // LIST
  // =========================================================

  private async listByPage(
    page: number,
    sort: ModaiSort,
  ): Promise<ModaiResponse> {
    const total = await this.countEligibleProducts();

    const rows = await this.applySort(this.createEligibleProductQuery(), sort)
      .select('product.id', 'productId')
      .addSelect(
        "DATE_FORMAT(product.createdAt, '%Y-%m-%dT%H:%i:%s')",
        'dateAdded',
      )
      .addSelect(
        `DATE_FORMAT(${LAST_CHANGE_EXPRESSION}, '%Y-%m-%dT%H:%i:%s')`,
        'dateUpdated',
      )
      .limit(MODAI_PAGE_SIZE)
      .offset((page - 1) * MODAI_PAGE_SIZE)
      .getRawMany<ProductRow>();

    return {
      api_version: MODAI_API_VERSION,
      current_page: page,
      total,
      max_pages: Math.max(1, Math.ceil(total / MODAI_PAGE_SIZE)),
      products: await this.buildProductsFromRows(rows),
    };
  }

  /** بارگذاری محصولات یک صفحه و ساخت خروجی مدآی */
  private async buildProductsFromRows(
    rows: ProductRow[],
  ): Promise<ModaiProduct[]> {
    const products = await this.loadProducts(
      rows.map(row => Number(row.productId)),
    );

    const [sales, guidesByProduct] = await Promise.all([
      this.discountsService.getActiveSales(),
      this.productGuidesService.resolveGuidesForProducts(products),
    ]);

    return this.buildProducts(rows, products, sales, guidesByProduct);
  }

  /**
   * محصولاتی که نباید در مدآی دیده شوند در لیست نمی‌آیند:
   *  - بدون تنوعِ قیمت‌دار (قیمت بزرگ‌تر از صفر)
   *  - بدون دسته‌بندی فعال
   *  - بدون هیچ تصویر (مدآی برای محصول بدون تصویر خطا می‌گیرد)
   *
   * برای اینکه صفحه‌بندی دقیق بماند، به‌جای JOIN از EXISTS استفاده می‌شود تا
   * ردیف‌ها تکراری نشوند.
   */
  private createEligibleProductQuery(): SelectQueryBuilder<Product> {
    const query = this.productRepo
      .createQueryBuilder('product')
      .where(
        `EXISTS (
          SELECT 1 FROM variant variant_price
          WHERE variant_price.product_id = product.id
            AND variant_price.price > 0
        )`,
      )
      .andWhere(
        `EXISTS (
          SELECT 1
          FROM product_categories pc
          INNER JOIN category c ON c.id = pc.category_id
          WHERE pc.product_id = product.id AND c.isActive = 1
        )`,
      )
      .andWhere(
        `(
          (product.image IS NOT NULL AND product.image <> '')
          OR EXISTS (
            SELECT 1 FROM product_color_image pci
            WHERE pci.product_id = product.id
          )
        )`,
      );

    if (!this.includeOutOfStock) {
      query.andWhere(
        `EXISTS (
          SELECT 1 FROM variant variant_stock
          WHERE variant_stock.product_id = product.id
            AND variant_stock.stock > 0
            AND variant_stock.price > 0
        )`,
      );
    }

    return query;
  }

  private applySort(
    query: SelectQueryBuilder<Product>,
    sort: ModaiSort,
  ): SelectQueryBuilder<Product> {
    if (sort === 'date_updated_desc') {
      return query
        .orderBy(LAST_CHANGE_EXPRESSION, 'DESC')
        .addOrderBy('product.id', 'DESC');
    }

    return query
      .orderBy('product.createdAt', 'DESC')
      .addOrderBy('product.id', 'DESC');
  }

  private async countEligibleProducts(): Promise<number> {
    const rows = await this.createEligibleProductQuery()
      .select('COUNT(DISTINCT product.id)', 'total')
      .getRawMany<{ total: string | number }>();

    return Number(rows[0]?.total ?? 0);
  }

  private async loadProducts(productIds: number[]): Promise<Product[]> {
    if (!productIds.length) {
      return [];
    }

    return this.productRepo.find({
      where: { id: In(productIds) },
      relations: {
        variants: { color: true, size: true },
        colorImages: { color: true },
        categories: true,
      },
    });
  }

  // =========================================================
  // PAYLOAD BUILDING
  // =========================================================

  private buildProducts(
    rows: ProductRow[],
    products: Product[],
    sales: ActiveSale[],
    guidesByProduct: Map<number, ResolvedProductGuides>,
  ): ModaiProduct[] {
    const productById = new Map(products.map(product => [product.id, product]));

    const payload: ModaiProduct[] = [];

    for (const row of rows) {
      const product = productById.get(Number(row.productId));

      // اگر محصول بین دو کوئری حذف شده باشد، از لیست حذف می‌شود
      if (!product) {
        continue;
      }

      const colorImages = this.sortColorImages(product.colorImages);

      const imageLinks = this.buildImageLinks(product, colorImages);

      const categories = (product.categories ?? []).filter(
        category => category.isActive,
      );

      const categoryIds = categories.map(category => category.id);

      payload.push({
        product_unique: truncate(product.productCode, 200),
        product_url: truncate(this.buildProductUrl(product.slug), 1500),
        date_added: toTehranIso(row.dateAdded),
        date_updated: toTehranIso(row.dateUpdated),
        sku: truncate(product.productCode, 500) || null,
        title: truncate(product.title, 500),
        description: this.buildDescription(product),
        image_links: imageLinks,
        categories: categories.map(category => this.buildCategory(category)),
        variants: this.buildVariants(
          product,
          categoryIds,
          colorImages,
          imageLinks,
          sales,
        ),
        attributes: this.buildProductAttributes(product),
        // زوپینی فعلاً تگ محصول ندارد؛ آرایهٔ خالی به‌جای null فرستاده می‌شود
        tags: [],
        size_guide: buildSizeGuide(
          guidesByProduct.get(product.id) ?? null,
          file => this.buildImageUrl(file),
        ),
      });
    }

    return payload;
  }

  /**
   * آدرس مطلق صفحهٔ محصول.
   *
   * اسلاگ‌ها در زوپینی فارسی هستند و در سایت به‌صورت خام لینک می‌شوند، ولی
   * مدآی فقط آدرس مطلق قبول می‌کند؛ پس مسیر درصدی‌کد (percent-encoded) می‌شود.
   * بعضی اسلاگ‌ها از قبل کدشده ذخیره شده‌اند و نباید دوباره کد شوند.
   */
  private buildProductUrl(slug: string | null | undefined): string {
    const rawSlug = String(slug ?? '').trim();

    const path = /%[0-9a-f]{2}/i.test(rawSlug)
      ? rawSlug
      : encodeURIComponent(rawSlug);

    return `${this.siteUrl}${PRODUCT_PATH_PREFIX}${path}`;
  }

  private buildDescription(product: Product): string {
    const description = String(product.description ?? '').trim();

    if (!description) {
      return '';
    }

    return this.sendHtmlDescription
      ? description
      : htmlToPlainText(description);
  }

  private buildCategory(category: Category): ModaiCategory {
    return {
      id: String(category.id),
      title: truncate(category.name, 200),
    };
  }

  private buildVariants(
    product: Product,
    categoryIds: number[],
    colorImages: ProductColorImage[],
    imageLinks: string[],
    sales: ActiveSale[],
  ): ModaiVariant[] {
    const variants = [...(product.variants ?? [])].sort(
      (first, second) => first.id - second.id,
    );

    const payload: ModaiVariant[] = [];

    for (const variant of variants) {
      const originalPrice = Math.max(0, Math.round(Number(variant.price) || 0));

      // تنوع بدون قیمت قابل فروش نیست و در فید نمی‌آید
      if (originalPrice <= 0) {
        continue;
      }

      const bestSale = this.discountsService.pickBestSale(
        sales,
        product.id,
        categoryIds,
        originalPrice,
      );

      let price = bestSale
        ? Math.max(0, Math.round(bestSale.finalPrice))
        : originalPrice;

      // قیمت صفر (مثلاً فروش ویژهٔ ۱۰۰٪) به‌عنوان «محصول رایگان» ثبت نشود
      if (price <= 0) {
        price = originalPrice;
      }

      payload.push({
        id: String(variant.id),
        quantity: Math.max(0, Math.floor(Number(variant.stock) || 0)),
        price,
        // در نبود تخفیف، قیمت و قیمت قبلی برابرند (الزام مستند مدآی)
        old_price: Math.max(price, originalPrice),
        // طبق نمونهٔ مستند، در نبود تصویر رشتهٔ خالی فرستاده می‌شود
        image_link:
          this.findColorImage(colorImages, variant.colorId) ??
          imageLinks[0] ??
          '',
        attributes: this.buildVariantAttributes(variant),
      });
    }

    return payload;
  }

  private buildVariantAttributes(variant: Variant): ModaiVariantAttribute[] {
    const attributes: ModaiVariantAttribute[] = [];

    const colorName = String(variant.color?.name ?? '').trim();

    if (colorName) {
      attributes.push({
        id: String(variant.color.id),
        title: COLOR_ATTRIBUTE_TITLE,
        option: truncate(colorName, 200),
      });
    }

    const sizeName = String(variant.size?.name ?? '').trim();

    if (sizeName) {
      attributes.push({
        id: String(variant.size.id),
        title: SIZE_ATTRIBUTE_TITLE,
        option: truncate(sizeName, 200),
      });
    }

    return attributes;
  }

  /**
   * ویژگی‌های سطح محصول: همهٔ رنگ‌ها و سایزهای موجود در تنوع‌های محصول.
   * مدآی از این لیست برای فیلترهای صفحهٔ محصول استفاده می‌کند.
   */
  private buildProductAttributes(product: Product): ModaiProductAttribute[] {
    const variants = [...(product.variants ?? [])].sort(
      (first, second) => first.id - second.id,
    );

    const colors = new Map<number, string>();
    const sizes = new Map<number, string>();

    for (const variant of variants) {
      const colorName = String(variant.color?.name ?? '').trim();
      const sizeName = String(variant.size?.name ?? '').trim();

      if (variant.color?.id && colorName && !colors.has(variant.color.id)) {
        colors.set(variant.color.id, truncate(colorName, 200));
      }

      if (variant.size?.id && sizeName && !sizes.has(variant.size.id)) {
        sizes.set(variant.size.id, truncate(sizeName, 200));
      }
    }

    const attributes: ModaiProductAttribute[] = [];

    if (colors.size) {
      attributes.push({
        id: 'color',
        title: COLOR_ATTRIBUTE_TITLE,
        options: [...colors.values()],
      });
    }

    if (sizes.size) {
      attributes.push({
        id: 'size',
        title: SIZE_ATTRIBUTE_TITLE,
        options: [...sizes.values()],
      });
    }

    return attributes;
  }

  private sortColorImages(images?: ProductColorImage[]): ProductColorImage[] {
    return [...(images ?? [])].sort(
      (first, second) => first.order - second.order || first.id - second.id,
    );
  }

  /**
   * تصویر اصلی محصول باید اولین آیتم `image_links` باشد (الزام مدآی) و بعد از
   * آن، بقیهٔ تصاویر گالری.
   */
  private buildImageLinks(
    product: Product,
    colorImages: ProductColorImage[],
  ): string[] {
    const links: string[] = [];
    const seen = new Set<string>();

    const push = (value: string | null | undefined) => {
      const url = this.buildImageUrl(value);

      if (url && !seen.has(url)) {
        seen.add(url);
        links.push(truncate(url, 1000));
      }
    };

    push(product.image);

    for (const image of colorImages) {
      push(image.url);
    }

    return links.slice(0, MODAI_MAX_IMAGE_LINKS);
  }

  private findColorImage(
    colorImages: ProductColorImage[],
    colorId: number | null | undefined,
  ): string | null {
    if (!colorId) {
      return null;
    }

    const image = colorImages.find(item => item.color?.id === colorId);

    return image ? this.buildImageUrl(image.url) : null;
  }

  private buildImageUrl(value: string | null | undefined): string | null {
    return toAbsoluteUrl(value, {
      siteUrl: this.siteUrl,
      imageBaseUrl: this.imageBaseUrl,
      uploadPath: UPLOAD_PATH,
    });
  }
}
