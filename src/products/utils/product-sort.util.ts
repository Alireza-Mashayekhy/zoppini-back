import { SelectQueryBuilder } from 'typeorm';

/** فیلدهایی که مرتب‌سازی لیست محصولات روی آن‌ها مجاز است */
const SORTABLE_FIELDS = ['title', 'price', 'createdAt', 'id', 'sold'] as const;

type SortableField = (typeof SORTABLE_FIELDS)[number];

type SortDirection = 'ASC' | 'DESC';

interface ParsedProductSort {
  field: SortableField;
  direction: SortDirection;
}

/** ستون واقعی هر فیلد در کوئری محصولات */
const FIELD_COLUMNS: Record<Exclude<SortableField, 'sold'>, string> = {
  title: 'products.title',
  price: 'variant.price',
  createdAt: 'products.createdAt',
  id: 'products.id',
};

/**
 * مجموع تعداد اقلام فروخته‌شدهٔ هر محصول از روی سفارش‌های واقعی.
 *
 * فقط وضعیت‌های پرداخت‌شده/ارسال‌شده/تحویل‌شده شمرده می‌شوند؛ سفارش‌های
 * در انتظار پرداخت و لغوشده فروش محسوب نمی‌شوند. این یک زیرکوئری هم‌بسته
 * است تا با joinهای واریانت (که هر محصول چند ردیف دارد) تعداد دوبار
 * جمع نشود. نام جدول `order` در MySQL کلمهٔ رزرو است و باید backtick شود.
 */
export const PRODUCT_SOLD_COUNT_SQL = `(
  SELECT COALESCE(SUM(order_item.quantity), 0)
  FROM order_item
  INNER JOIN \`order\` ON \`order\`.id = order_item.order_id
  INNER JOIN variant ON variant.id = order_item.variant_id
  WHERE variant.product_id = products.id
    AND \`order\`.status IN ('paid', 'shipped', 'delivered')
)`;

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
    SORTABLE_FIELDS.find(
      candidate => candidate.toLowerCase() === normalizedField,
    ) ?? 'id';

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

  if (parsed.field === 'sold') {
    qb.addSelect(PRODUCT_SOLD_COUNT_SQL, 'soldCount');
    qb.orderBy('soldCount', parsed.direction);
    qb.addOrderBy(FIELD_COLUMNS.id, 'DESC');
    return qb;
  }

  const column = FIELD_COLUMNS[parsed.field];

  qb.orderBy(column, parsed.direction);

  if (parsed.field !== 'id') {
    qb.addOrderBy(FIELD_COLUMNS.id, parsed.direction);
  }

  return qb;
}
