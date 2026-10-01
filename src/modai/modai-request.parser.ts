import {
  MODAI_MAX_LOOKUP_UNIQUES,
  MODAI_SORT_VALUES,
  ModaiParsedRequest,
  ModaiSort,
} from './interfaces/modai-api.interface';
import { ModaiApiException } from './modai-api.exception';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * اعتبارسنجی و نرمال‌سازی body درخواست.
 *
 * طبق مستند مدآی، body باید `{ "page": 1, "sort": "date_added_desc" }` باشد و
 * هر دو پارامتر اجباری‌اند؛ برای مثال درخواست `{ "page": 1 }` باید با خطای
 * `{ "error": "sort parameter is not provided" }` و کد ۴۰۰ برگردد.
 *
 * تنها تساهل عمدی: کلیدهای ناشناخته خطا نمی‌دهند و فقط برای لاگ برگردانده
 * می‌شوند (ممکن است مدآی در آینده فیلدهای اضافه بفرستد)؛ نوع و محدودهٔ
 * پارامترهای شناخته‌شده سخت‌گیرانه کنترل می‌شود.
 */
export function parseModaiRequest(body: unknown): ModaiParsedRequest {
  if (!isPlainObject(body)) {
    throw ModaiApiException.badRequest(
      'request body is empty or not a valid JSON object',
    );
  }

  const page = body.page;

  if (page === undefined || page === null) {
    throw ModaiApiException.badRequest('page parameter is not provided');
  }

  if (
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isFinite(page)
  ) {
    throw ModaiApiException.badRequest(
      'page must be an integer greater than or equal to 1',
    );
  }

  const sort = parseSort(body.sort);
  const unknownKeys = Object.keys(body)
    .filter(key => key !== 'page' && key !== 'sort')
    .sort();

  return { page, sort, unknownKeys };
}

function isModaiSort(value: string): value is ModaiSort {
  return (MODAI_SORT_VALUES as readonly string[]).includes(value);
}

function parseSort(raw: unknown): ModaiSort {
  // طبق مستند مدآی، `sort` اجباری است و نبودش باید ۴۰۰ بدهد
  if (
    raw === undefined ||
    raw === null ||
    (typeof raw === 'string' && !raw.trim())
  ) {
    throw ModaiApiException.badRequest('sort parameter is not provided');
  }

  if (typeof raw !== 'string') {
    throw ModaiApiException.badRequest('sort must be a string');
  }

  const sort = raw.trim();

  if (!isModaiSort(sort)) {
    throw ModaiApiException.badRequest(
      `invalid sort value "${raw}"; allowed values are ${MODAI_SORT_VALUES.join(
        ', ',
      )}`,
    );
  }

  return sort;
}

/**
 * اعتبارسنجی body درخواست `products-by-uniques`.
 *
 * body: `{ "product_uniques": ["1234", "5678"] }`
 *
 * لیست نهایی بدون تکرار و با حفظ ترتیب ورودی برگردانده می‌شود.
 */
export function parseModaiUniquesRequest(body: unknown): string[] {
  if (!isPlainObject(body)) {
    throw ModaiApiException.badRequest(
      'request body is empty or not a valid JSON object',
    );
  }

  const raw = body.product_uniques;

  if (raw === undefined || raw === null) {
    throw ModaiApiException.badRequest(
      'product_uniques parameter is not provided',
    );
  }

  if (!Array.isArray(raw)) {
    throw ModaiApiException.badRequest(
      'product_uniques must be a list of strings',
    );
  }

  if (raw.length === 0) {
    throw ModaiApiException.badRequest('product_uniques must not be empty');
  }

  if (raw.length > MODAI_MAX_LOOKUP_UNIQUES) {
    throw ModaiApiException.badRequest(
      `product_uniques must not contain more than ${MODAI_MAX_LOOKUP_UNIQUES} items`,
    );
  }

  const uniques: string[] = [];

  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw ModaiApiException.badRequest(
        'product_uniques must be a list of strings',
      );
    }

    uniques.push(item.trim());
  }

  return [...new Set(uniques)];
}
