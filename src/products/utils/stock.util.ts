import { Repository } from 'typeorm';

import { Variant } from '../entities/variant.entity';

export interface ProductColorPair {
  productId: number;
  colorId: number;
}

/**
 * ساخت کوئری product_id/color_idهایی که حداقل یک variant با موجودی دارند.
 */
export function buildInStockPairsQuery(
  variantRepo: Repository<Variant>,
  pairs: ProductColorPair[],
) {
  return variantRepo
    .createQueryBuilder('variant')
    .select('DISTINCT variant.product_id', 'productId')
    .addSelect('variant.color_id', 'colorId')
    .where('variant.product_id IN (:...productIds)', {
      productIds: [...new Set(pairs.map(pair => pair.productId))],
    })
    .andWhere('variant.color_id IN (:...colorIds)', {
      colorIds: [...new Set(pairs.map(pair => pair.colorId))],
    })
    .andWhere('variant.stock > 0');
}

/**
 * برگرداندن مجموعه‌ای از کلیدهای `productId-colorId` که موجودی دارند.
 */
export async function findInStockProductColorPairs(
  variantRepo: Repository<Variant>,
  pairs: ProductColorPair[],
): Promise<Set<string>> {
  const validPairs = (pairs ?? []).filter(
    pair => pair?.productId != null && pair?.colorId != null,
  );

  if (!validPairs.length) {
    return new Set<string>();
  }

  const rows = await buildInStockPairsQuery(
    variantRepo,
    validPairs,
  ).getRawMany<{ productId: number; colorId: number }>();

  return new Set(
    rows.map(row => `${Number(row.productId)}-${Number(row.colorId)}`),
  );
}

/**
 * برگرداندن مجموعه‌ای از productIdهایی که حداقل یک variant با موجودی دارند.
 */
export async function findInStockProductIds(
  variantRepo: Repository<Variant>,
  productIds: number[],
): Promise<Set<number>> {
  const ids = [...new Set((productIds ?? []).filter(id => id != null))];

  if (!ids.length) {
    return new Set<number>();
  }

  const rows = await variantRepo
    .createQueryBuilder('variant')
    .select('DISTINCT variant.product_id', 'productId')
    .where('variant.product_id IN (:...productIds)', { productIds: ids })
    .andWhere('variant.stock > 0')
    .getRawMany<{ productId: number }>();

  return new Set(rows.map(row => Number(row.productId)));
}
