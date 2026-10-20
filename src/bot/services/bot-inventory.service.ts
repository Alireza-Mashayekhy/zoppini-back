import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Variant } from 'src/products/entities/variant.entity';
import { Repository } from 'typeorm';

import { BOT_TIME_ZONE } from '../bot.constants';
import { InventoryQueryDto, LowStockQueryDto } from '../dto/orders-query.dto';
import { getDefaultLowStockThreshold } from '../utils/bot-config.util';

/**
 * در سورس سایت، موجودی قابل‌فروش `Variant.stock` است:
 *
 * - cart.service.ts و order.service.ts هنگام افزودن به سبد و تأیید پرداخت
 *   فقط همین فیلد را با تعداد سفارش مقایسه می‌کنند.
 * - هر دو مسیر sync راهکاران مقدار `stock` را برابر
 *   `stockRetail + stockHadishMall` می‌گذارند
 *   (rahkaran.service.ts → extractBothWarehouseStocks، total).
 *
 * بنابراین `stock` ملاک است و دو فیلد دیگر فقط breakdown انبار هستند.
 */
const SELLABLE_STOCK_FIELD = 'stock';

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

interface VariantRow {
  id: number;
  sku: string | null;
  stock: number;
  stockRetail: number;
  stockHadishMall: number;
  updatedAt: Date;
  product?: {
    id: number;
    title: string;
    slug: string;
  };
  color?: {
    id: number;
    name: string;
  } | null;
  size?: {
    id: number;
    name: string;
  } | null;
}

@Injectable()
export class BotInventoryService {
  constructor(
    @InjectRepository(Variant)
    private readonly variantRepo: Repository<Variant>,
  ) {}

  private async getLastVariantUpdateAt(): Promise<string | null> {
    const raw = await this.variantRepo
      .createQueryBuilder('v')
      .select('MAX(v.updatedAt)', 'lastUpdatedAt')
      .getRawOne<{ lastUpdatedAt: string | Date | null }>();

    if (!raw?.lastUpdatedAt) {
      return null;
    }

    const value = new Date(raw.lastUpdatedAt);

    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  private mapVariant(variant: VariantRow) {
    return {
      variantId: variant.id,
      sku: variant.sku,
      productTitle: variant.product?.title ?? 'محصول حذف‌شده',
      productSlug: variant.product?.slug ?? null,
      color: variant.color?.name ?? null,
      size: variant.size?.name ?? null,
      // فیلد قابل‌فروش؛ با منطق سبد خرید و سفارش سایت یکسان است.
      sellableStock: toNumber(variant.stock),
      // فقط برای شفافیت انبار؛ در محاسبه‌ی موجودی قابل‌فروش دوباره جمع نمی‌شود.
      stockRetail: toNumber(variant.stockRetail),
      stockHadishMall: toNumber(variant.stockHadishMall),
      lastVariantUpdatedAt: variant.updatedAt?.toISOString() ?? null,
    };
  }

  private buildStockBasis(threshold?: number) {
    return {
      sellableStockField: SELLABLE_STOCK_FIELD,
      formula:
        'stock = stockRetail + stockHadishMall (مقدار محاسبه‌شده توسط sync راهکاران)',
      breakdownFields: ['stockRetail', 'stockHadishMall'],
      breakdownMustNotBeSummedWithSellableStock: true,
      threshold: threshold ?? null,
      exactRahkaranSyncTimestampStored: false,
      lastUpdateSource:
        'MAX(variant.updatedAt) — تقریبی؛ زمان دقیق اجرای sync ذخیره نمی‌شود.',
      timeZone: BOT_TIME_ZONE,
    };
  }

  async getLowStock(query: LowStockQueryDto) {
    const threshold = query.threshold ?? getDefaultLowStockThreshold();

    const [[variants, total], lastVariantUpdateAt] = await Promise.all([
      this.variantRepo
        .createQueryBuilder('v')
        .leftJoin('v.product', 'product')
        .leftJoin('v.color', 'color')
        .leftJoin('v.size', 'size')
        .select([
          'v.id',
          'v.sku',
          'v.stock',
          'v.stockRetail',
          'v.stockHadishMall',
          'v.updatedAt',
          'product.id',
          'product.title',
          'product.slug',
          'color.id',
          'color.name',
          'size.id',
          'size.name',
        ])
        .where('v.stock <= :threshold', { threshold })
        .orderBy('v.stock', 'ASC')
        .addOrderBy('product.title', 'ASC')
        .addOrderBy('v.id', 'ASC')
        .skip((query.page - 1) * query.limit)
        .take(query.limit)
        .getManyAndCount(),
      this.getLastVariantUpdateAt(),
    ]);

    return {
      threshold,
      defaultThreshold: getDefaultLowStockThreshold(),
      items: (variants as unknown as VariantRow[]).map(variant =>
        this.mapVariant(variant),
      ),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
      stockBasis: this.buildStockBasis(threshold),
      lastVariantUpdateAt,
    };
  }

  async searchInventory(query: InventoryQueryDto) {
    const normalized = query.query.trim();

    if (normalized.length < 2) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'عبارت جست‌وجو باید حداقل ۲ کاراکتر باشد.',
        error: 'Bad Request',
        code: 'INVALID_INVENTORY_QUERY',
      });
    }

    const pattern = `%${escapeLike(normalized)}%`;

    const [[variants, total], lastVariantUpdateAt] = await Promise.all([
      this.variantRepo
        .createQueryBuilder('v')
        .leftJoin('v.product', 'product')
        .leftJoin('v.color', 'color')
        .leftJoin('v.size', 'size')
        .select([
          'v.id',
          'v.sku',
          'v.stock',
          'v.stockRetail',
          'v.stockHadishMall',
          'v.updatedAt',
          'product.id',
          'product.title',
          'product.slug',
          'color.id',
          'color.name',
          'size.id',
          'size.name',
        ])
        .where('(product.title LIKE :pattern OR v.sku LIKE :pattern)', {
          pattern,
        })
        .orderBy('v.stock', 'DESC')
        .addOrderBy('product.title', 'ASC')
        .addOrderBy('v.id', 'ASC')
        .skip((query.page - 1) * query.limit)
        .take(query.limit)
        .getManyAndCount(),
      this.getLastVariantUpdateAt(),
    ]);

    return {
      query: normalized,
      items: (variants as unknown as VariantRow[]).map(variant =>
        this.mapVariant(variant),
      ),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
      stockBasis: this.buildStockBasis(),
      lastVariantUpdateAt,
    };
  }
}
