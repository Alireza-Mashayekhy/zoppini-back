import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Product } from '../products/entities/product.entity';
import { Variant } from '../products/entities/variant.entity';
import { RahkaranService } from './rahkaran.service';

export interface RahkaranProduct {
  productId: number;
  productNumber: string;
  productName: string;
  fee: number;
  partId: number;
  unitRef: number;
}

interface SyncVariantResult {
  variantId: number;
  sku: string;
  oldPrice: number;
  newPrice: number;
  oldStock: number;
  newStock: number;
  changed: boolean;
}

interface SyncResult {
  requested: number;
  matched: number;
  updated: number;
  unchanged: number;
  notFound: number;
  failed: number;
  variants: SyncVariantResult[];
  errors: {
    variantId?: number;
    sku?: string;
    message: string;
  }[];
}

@Injectable()
export class RahkaranProductSyncService {
  private readonly logger = new Logger(RahkaranProductSyncService.name);

  private readonly stockStoreId: number;

  /**
   * حداکثر تعداد request همزمان برای گرفتن موجودی
   *
   * اگر راهکاران تحمل بیشتری داشت بعداً می‌توانیم افزایش دهیم.
   */
  private readonly concurrency = 10;

  constructor(
    private readonly rahkaranService: RahkaranService,

    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,

    @InjectRepository(Variant)
    private readonly variantRepo: Repository<Variant>,
  ) {
    this.stockStoreId = Number(process.env.RAHKARAN_STOCK_STORE_ID || 0);

    if (!this.stockStoreId) {
      this.logger.warn('RAHKARAN_STOCK_STORE_ID تنظیم نشده است.');
    }
  }

  // ============================================================
  // 1. Sync ALL Products
  // ============================================================

  async syncAllProducts(): Promise<SyncResult> {
    this.logger.log('🔄 شروع Sync تمام Variantها با راهکاران...');

    const variants = await this.variantRepo.find({
      where: {},
      order: {
        id: 'ASC',
      },
    });

    this.logger.log(`📦 تعداد Variantهای سایت: ${variants.length}`);

    if (!variants.length) {
      return {
        requested: 0,
        matched: 0,
        updated: 0,
        unchanged: 0,
        notFound: 0,
        failed: 0,
        variants: [],
        errors: [],
      };
    }

    return this.syncVariants(variants);
  }

  // ============================================================
  // 2. Sync ONE Product
  // ============================================================

  async syncProduct(productId: number): Promise<SyncResult> {
    const product = await this.productRepo.findOne({
      where: {
        id: productId,
      },
      relations: {
        variants: true,
      },
    });

    if (!product) {
      throw new NotFoundException(`محصول با شناسه ${productId} یافت نشد`);
    }

    if (!product.variants?.length) {
      return {
        requested: 0,
        matched: 0,
        updated: 0,
        unchanged: 0,
        notFound: 0,
        failed: 0,
        variants: [],
        errors: [],
      };
    }

    this.logger.log(
      `🔄 Sync محصول ${productId} - ${product.title} - ${product.variants.length} Variant`,
    );

    return this.syncVariants(product.variants);
  }

  // ============================================================
  // 3. Core Sync
  // ============================================================

  async syncVariants(variants: Variant[]): Promise<SyncResult> {
    const result: SyncResult = {
      requested: variants.length,
      matched: 0,
      updated: 0,
      unchanged: 0,
      notFound: 0,
      failed: 0,
      variants: [],
      errors: [],
    };

    if (!variants.length) {
      return result;
    }

    // ----------------------------------------------------------
    // SKUهای معتبر
    // ----------------------------------------------------------

    const validVariants = variants.filter(variant => !!variant.sku?.trim());

    result.notFound += variants.length - validVariants.length;

    for (const variant of variants) {
      if (!variant.sku?.trim()) {
        result.errors.push({
          variantId: variant.id,
          message: 'Variant فاقد SKU است.',
        });
      }
    }

    if (!validVariants.length) {
      return result;
    }

    // ----------------------------------------------------------
    // دریافت لیست محصولات راهکاران
    // ----------------------------------------------------------

    const rahkaranProducts = await this.fetchAllRahkaranProducts();

    this.logger.log(
      `📦 تعداد محصولات دریافت‌شده از راهکاران: ${rahkaranProducts.length}`,
    );

    // ----------------------------------------------------------
    // Map بر اساس SKU
    // ----------------------------------------------------------

    const rahkaranMap = new Map<string, RahkaranProduct>();

    for (const product of rahkaranProducts) {
      const sku = product.productNumber?.trim();

      if (!sku) {
        continue;
      }

      rahkaranMap.set(sku, product);
    }

    // ----------------------------------------------------------
    // پیدا کردن Matchها
    // ----------------------------------------------------------

    const matchedVariants: {
      variant: Variant;
      rahkaranProduct: RahkaranProduct;
    }[] = [];

    for (const variant of validVariants) {
      const sku = variant.sku!.trim();

      const rahkaranProduct = rahkaranMap.get(sku);

      if (!rahkaranProduct) {
        result.notFound++;

        result.errors.push({
          variantId: variant.id,
          sku,
          message: 'محصول با این SKU در راهکاران پیدا نشد.',
        });

        continue;
      }

      matchedVariants.push({
        variant,
        rahkaranProduct,
      });
    }

    result.matched = matchedVariants.length;

    if (!matchedVariants.length) {
      return result;
    }

    // ----------------------------------------------------------
    // دریافت موجودی
    // ----------------------------------------------------------

    const stockResults = await this.fetchStocks(matchedVariants);

    // ----------------------------------------------------------
    // Update DB
    // ----------------------------------------------------------

    const variantsToSave: Variant[] = [];

    for (const item of matchedVariants) {
      const { variant, rahkaranProduct } = item;

      const stockResult = stockResults.get(rahkaranProduct.productId);

      if (!stockResult) {
        result.failed++;

        result.errors.push({
          variantId: variant.id,
          sku: variant.sku!,
          message: 'دریافت موجودی از راهکاران ناموفق بود.',
        });

        continue;
      }

      const newPrice = Number(rahkaranProduct.fee ?? 0);

      const newStock = this.extractStock(stockResult);

      const oldPrice = Number(variant.price);
      const oldStock = Number(variant.stock);

      const changed = oldPrice !== newPrice || oldStock !== newStock;

      if (!changed) {
        result.unchanged++;
      } else {
        variant.price = newPrice;
        variant.stock = newStock;

        variantsToSave.push(variant);

        result.updated++;
      }

      result.variants.push({
        variantId: variant.id,
        sku: variant.sku!,
        oldPrice,
        newPrice,
        oldStock,
        newStock,
        changed,
      });
    }

    // ----------------------------------------------------------
    // Save به صورت Chunk
    // ----------------------------------------------------------

    if (variantsToSave.length) {
      const chunkSize = 500;

      for (let i = 0; i < variantsToSave.length; i += chunkSize) {
        const chunk = variantsToSave.slice(i, i + chunkSize);

        await this.variantRepo.save(chunk, {
          chunk: chunkSize,
          transaction: true,
        });
      }
    }

    this.logger.log(
      `✅ Sync تمام شد | ` +
        `Requested: ${result.requested} | ` +
        `Matched: ${result.matched} | ` +
        `Updated: ${result.updated} | ` +
        `Unchanged: ${result.unchanged} | ` +
        `NotFound: ${result.notFound} | ` +
        `Failed: ${result.failed}`,
    );

    return result;
  }

  // ============================================================
  // Rahkaran Products Pagination
  // ============================================================

  private async fetchAllRahkaranProducts(): Promise<RahkaranProduct[]> {
    const allProducts: RahkaranProduct[] = [];

    const count = 500;
    let page = 1;

    while (true) {
      const products = await this.rahkaranService.getRetailProducts(
        '',
        page,
        count,
      );

      if (!products?.length) {
        break;
      }

      allProducts.push(...(products as RahkaranProduct[]));

      this.logger.debug(
        `Rahkaran Products page=${page}, count=${products.length}`,
      );

      if (products.length < count) {
        break;
      }

      page++;
    }

    return allProducts;
  }

  // ============================================================
  // Stock Requests
  // ============================================================

  private async fetchStocks(
    matchedVariants: {
      variant: Variant;
      rahkaranProduct: RahkaranProduct;
    }[],
  ): Promise<
    Map<
      number,
      Awaited<ReturnType<RahkaranService['getRemainingQuantityInfo']>>
    >
  > {
    const result = new Map<number, any>();

    /**
     * اگر چند Variant به یک محصول راهکاران اشاره کنند،
     * فقط یک بار موجودی آن productId را می‌گیریم.
     */
    const uniqueProducts = new Map<number, RahkaranProduct>();

    for (const item of matchedVariants) {
      uniqueProducts.set(item.rahkaranProduct.productId, item.rahkaranProduct);
    }

    const items = [...uniqueProducts.values()];

    for (let i = 0; i < items.length; i += this.concurrency) {
      const chunk = items.slice(i, i + this.concurrency);

      const responses = await Promise.allSettled(
        chunk.map(async product => {
          const stock = await this.rahkaranService.getRemainingQuantityInfo(
            product.productId,
          );

          return {
            productId: product.productId,
            stock,
          };
        }),
      );

      for (const response of responses) {
        if (response.status === 'fulfilled') {
          result.set(response.value.productId, response.value.stock);
        } else {
          this.logger.error(
            '❌ دریافت موجودی یک محصول از راهکاران شکست خورد.',
            response.reason,
          );
        }
      }

      this.logger.debug(
        `Stock sync: ${Math.min(
          i + this.concurrency,
          items.length,
        )}/${items.length}`,
      );
    }

    return result;
  }

  // ============================================================
  // Extract Stock
  // ============================================================

  private extractStock(
    stocks: Awaited<ReturnType<RahkaranService['getRemainingQuantityInfo']>>,
  ): number {
    if (!stocks?.length) {
      return 0;
    }

    if (!this.stockStoreId) {
      throw new BadRequestException('RAHKARAN_STOCK_STORE_ID تنظیم نشده است.');
    }

    const store = stocks.find(
      item => Number(item.StoreID) === this.stockStoreId,
    );

    if (!store) {
      return 0;
    }

    /**
     * RemainingQuantity همان موجودی قابل فروش است
     * که مستندات راهکاران برای موجودی محصول برمی‌گرداند.
     */
    return Number(store.RemainingQuantity ?? 0);
  }
}
