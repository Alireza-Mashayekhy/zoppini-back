import { SelectQueryBuilder } from 'typeorm';

import { applyProductSort, parseProductSort } from './product-sort.util';

function createQueryBuilder() {
  const qb = {
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
  };
  qb.orderBy.mockReturnValue(qb);
  qb.addOrderBy.mockReturnValue(qb);
  return qb;
}

function run(sort?: string) {
  const qb = createQueryBuilder();
  applyProductSort(qb as unknown as SelectQueryBuilder<object>, sort);
  return {
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
    expect(calls.orderBy).toEqual([]);
    expect(calls.addOrderBy).toEqual([]);
  });
});
