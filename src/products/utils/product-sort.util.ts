import { SelectQueryBuilder } from 'typeorm';

/** فیلدهایی که مرتب‌سازی لیست محصولات روی آن‌ها مجاز است */
const SORTABLE_FIELDS = ['title', 'price', 'createdAt', 'id'] as const;

type SortableField = (typeof SORTABLE_FIELDS)[number];

type SortDirection = 'ASC' | 'DESC';

interface ParsedProductSort {
  field: SortableField;
  direction: SortDirection;
}

/** ستون واقعی هر فیلد در کوئری محصولات */
const FIELD_COLUMNS: Record<SortableField, string> = {
  title: 'products.title',
  price: 'variant.price',
  createdAt: 'products.createdAt',
  id: 'products.id',
};

/**
 * تجزیه‌ی پارامتر `sort` که به شکل `field:direction` می‌آید.
 *
 * جهت پیش‌فرض ASC است تا رفتار قبلی برای `sort=createdAt` عوض نشود.
 * فیلد ناشناخته به `id` برمی‌گردد (همان رفتار قبلیِ `default`)، ولی چون
 * فیلد از بین مقادیر مجاز انتخاب می‌شود، امکان تزریق SQL وجود ندارد.
 */
export function parseProductSort(sort?: string): ParsedProductSort | null {
  if (!sort) return null;

  const [rawField, rawDirection] = sort.split(':');

  const normalizedField = (rawField || '').trim().toLowerCase();

  const field: SortableField =
    SORTABLE_FIELDS.find(candidate => candidate.toLowerCase() === normalizedField) ??
    'id';

  const direction: SortDirection =
    (rawDirection || '').trim().toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  return { field, direction };
}

/**
 * اعمال مرتب‌سازی لیست محصولات.
 *
 * یک `ORDER BY` پایدار با `products.id` هم اضافه می‌شود؛ بدون آن، محصولاتی
 * که `createdAt` یکسان دارند (مثلاً محصولات وارد‌شده‌ی گروهی) ترتیب ثابتی
 * ندارند و بین صفحه‌های لیست/اسکرول بی‌نهایت ممکن است تکرار یا حذف شوند.
 */
export function applyProductSort<T extends object>(
  qb: SelectQueryBuilder<T>,
  sort?: string,
): SelectQueryBuilder<T> {
  const parsed = parseProductSort(sort);

  if (!parsed) return qb;

  const column = FIELD_COLUMNS[parsed.field];

  qb.orderBy(column, parsed.direction);

  if (parsed.field !== 'id') {
    qb.addOrderBy(FIELD_COLUMNS.id, parsed.direction);
  }

  return qb;
}
