import { SelectQueryBuilder } from 'typeorm';

import {
  applyProductSort,
  parseProductSort,
  PRODUCT_SOLD_COUNT_SQL,
} from './product-sort.util';

function createQueryBuilder() {
  const qb = {
    addSelect: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
  };
  qb.addSelect.mockReturnValue(qb);
  qb.orderBy.mockReturnValue(qb);
  qb.addOrderBy.mockReturnValue(qb);
  return qb;
}

function run(sort?: string) {
  const qb = createQueryBuilder();
  applyProductSort(qb as unknown as SelectQueryBuilder<object>, sort);
  return {
    addSelect: qb.addSelect.mock.calls,
    orderBy: qb.orderBy.mock.calls,
    addOrderBy: qb.addOrderBy.mock.calls,
  };
}

describe('product sort', () => {
  it('parses a field and direction', () => {
    expect(parseProductSort('createdAt:desc')).toEqual({
      field: 'createdAt',
      direction: 'DESC',
    });
    expect(parseProductSort('price:ASC')).toEqual({
      field: 'price',
      direction: 'ASC',
    });
  });

  it('returns null without a sort value', () => {
    expect(parseProductSort(undefined)).toBeNull();
    expect(parseProductSort('')).toBeNull();
  });

  it('falls back to id for an unknown field and ASC for a missing direction', () => {
    expect(parseProductSort('unknownField')).toEqual({
      field: 'id',
      direction: 'ASC',
    });
  });

  it('orders newest first for createdAt:desc', () => {
    const calls = run('createdAt:desc');
    expect(calls.orderBy).toEqual([['products.createdAt', 'DESC']]);
    // کلید دوم تضمین می‌کند محصولات با تاریخ یکسان ترتیب ثابت داشته باشند
    expect(calls.addOrderBy).toEqual([['products.id', 'DESC']]);
  });

  it('orders oldest first for createdAt:asc', () => {
    const calls = run('createdAt:asc');
    expect(calls.orderBy).toEqual([['products.createdAt', 'ASC']]);
    expect(calls.addOrderBy).toEqual([['products.id', 'ASC']]);
  });

  it('parses the real sold-count sort', () => {
    expect(parseProductSort('sold:desc')).toEqual({
      field: 'sold',
      direction: 'DESC',
    });
  });

  it('orders best sellers by the sum of sold order-item quantities', () => {
    const calls = run('sold:desc');
    expect(calls.addSelect).toEqual([[PRODUCT_SOLD_COUNT_SQL, 'soldCount']]);
    expect(calls.orderBy).toEqual([['soldCount', 'DESC']]);
    expect(calls.addOrderBy).toEqual([['products.id', 'DESC']]);
    // سفارش‌های لغوشده/در انتظار پرداخت فروش محسوب نمی‌شوند
    expect(PRODUCT_SOLD_COUNT_SQL).toContain('order_item.quantity');
    expect(PRODUCT_SOLD_COUNT_SQL).toContain("'paid', 'shipped', 'delivered'");
    expect(PRODUCT_SOLD_COUNT_SQL).not.toContain('pending');
  });

  it('sorts by price and title on the right columns', () => {
    expect(run('price:asc').orderBy).toEqual([['variant.price', 'ASC']]);
    expect(run('title:desc').orderBy).toEqual([['products.title', 'DESC']]);
  });

  it('does not add a redundant id order when sorting by id', () => {
    const calls = run('id:desc');
    expect(calls.orderBy).toEqual([['products.id', 'DESC']]);
    expect(calls.addOrderBy).toEqual([]);
  });

  it('leaves the query untouched without a sort value', () => {
    const calls = run(undefined);
    expect(calls.addSelect).toEqual([]);
    expect(calls.orderBy).toEqual([]);
    expect(calls.addOrderBy).toEqual([]);
  });
});
