import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export function applySort<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  sort?: string,
  alias?: string,
) {
  if (!sort) return qb;

  const [field, order] = sort.split(':');
  const orderField = alias ? `${alias}.${field}` : field;

  return qb.orderBy(orderField, (order?.toUpperCase() as any) || 'ASC');
}
