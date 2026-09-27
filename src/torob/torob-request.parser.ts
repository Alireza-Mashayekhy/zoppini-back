import {
  TOROB_SORT_VALUES,
  TorobCursor,
  TorobPageSort,
  TorobParsedRequest,
} from './interfaces/torob-api.interface';
import { TorobApiException } from './torob-api.exception';

/**
 * کلیدهای مجاز body. مستند ترب صریحاً می‌گوید هیچ پارامتری نباید مقدار پیش‌فرض
 * داشته باشد و هر پارامتر اشتباه باید خطای ۴۰۰ بدهد.
 */
const ALLOWED_KEYS = new Set([
  'page',
  'sort',
  'cursor',
  'page_uniques',
  'page_urls',
]);

/** حداکثر تعداد آیدی/لینک در یک درخواست تکی */
const MAX_LOOKUP_ITEMS = 1000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * cursor به صورت رشته‌ای برمی‌گردد و باید بدون تغییر در درخواست بعدی ارسال شود.
 * قالب تولیدی ما: `<lastVariantId>:<page>` تا بتوانیم `current_page` را هم
 * درست پر کنیم. برای سازگاری، cursorهایی که فقط شامل شناسه باشند هم پذیرفته می‌شوند.
 */
export function encodeCursor(cursor: TorobCursor): string {
  return `${cursor.lastVariantId}:${cursor.page}`;
}

export function decodeCursor(raw: string): TorobCursor {
  const [idPart, pagePart] = raw.split(':');

  const lastVariantId = Number(idPart);

  if (!Number.isInteger(lastVariantId) || lastVariantId < 0) {
    throw TorobApiException.badRequest('cursor is not valid');
  }

  const page = pagePart === undefined ? 1 : Number(pagePart);

  if (!Number.isInteger(page) || page < 1) {
    throw TorobApiException.badRequest('cursor is not valid');
  }

  return { lastVariantId, page };
}

function parseLookupList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw TorobApiException.badRequest(`${key} must be a list of strings`);
  }

  if (value.length === 0) {
    throw TorobApiException.badRequest(`${key} must not be empty`);
  }

  if (value.length > MAX_LOOKUP_ITEMS) {
    throw TorobApiException.badRequest(
      `${key} must not contain more than ${MAX_LOOKUP_ITEMS} items`,
    );
  }

  return value.map(item => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw TorobApiException.badRequest(`${key} must be a list of strings`);
    }

    return item.trim();
  });
}

/**
 * اعتبارسنجی و نرمال‌سازی body درخواست.
 *
 * خروجی یا یک خطای ۴۰۰ با پیام دقیق (برای رفع سریع خطا توسط کارشناسان ترب)
 * برمی‌گرداند.
 */
export function parseTorobRequest(body: unknown): TorobParsedRequest {
  if (!isPlainObject(body)) {
    throw TorobApiException.badRequest(
      'request body is empty or not a valid JSON object',
    );
  }

  const unknownKeys = Object.keys(body).filter(key => !ALLOWED_KEYS.has(key));

  if (unknownKeys.length) {
    throw TorobApiException.badRequest(
      `unsupported parameter(s): ${unknownKeys.join(', ')}`,
    );
  }

  const hasPage = 'page' in body;
  const hasSort = 'sort' in body;
  const hasCursor = 'cursor' in body;
  const hasUniques = 'page_uniques' in body;
  const hasUrls = 'page_urls' in body;

  // طبق مستند، در اولین درخواست cursor-based فقط `sort` ارسال می‌شود.
  const isFirstCursorPage =
    hasSort && !hasPage && !hasCursor && body.sort === 'product_id_desc';

  // `sort` بین دو حالت page و cursor مشترک است، پس تشخیص حالت فقط با
  // page/cursor/page_uniques/page_urls انجام می‌شود.
  const modes = [
    hasPage ? 'page' : null,
    hasCursor || isFirstCursorPage ? 'cursor' : null,
    hasUniques ? 'page_uniques' : null,
    hasUrls ? 'page_urls' : null,
  ].filter(Boolean);

  if (modes.length === 0) {
    if (hasSort) {
      throw TorobApiException.badRequest('page parameter is not provided');
    }

    throw TorobApiException.badRequest(
      'no parameters are provided; one of page+sort, cursor+sort, page_uniques or page_urls is required',
    );
  }

  if (modes.length > 1) {
    throw TorobApiException.badRequest(
      'only one request mode is allowed: page+sort, cursor+sort, page_uniques or page_urls',
    );
  }

  if (hasUniques) {
    return {
      mode: 'page_uniques',
      pageUniques: parseLookupList(body.page_uniques, 'page_uniques'),
    };
  }

  if (hasUrls) {
    return {
      mode: 'page_urls',
      pageUrls: parseLookupList(body.page_urls, 'page_urls'),
    };
  }

  if (hasCursor || isFirstCursorPage) {
    if (
      hasCursor &&
      (typeof body.cursor !== 'string' || body.cursor.trim() === '')
    ) {
      throw TorobApiException.badRequest('cursor must be a non-empty string');
    }

    if (!hasSort) {
      throw TorobApiException.badRequest('sort parameter is not provided');
    }

    if (body.sort !== 'product_id_desc') {
      throw TorobApiException.badRequest(
        'sort must be product_id_desc when cursor is used',
      );
    }

    const rawCursor = typeof body.cursor === 'string' ? body.cursor.trim() : '';

    return {
      mode: 'cursor',
      cursor: rawCursor
        ? decodeCursor(rawCursor)
        : { lastVariantId: 0, page: 1 },
      sort: 'product_id_desc',
    };
  }

  // حالت page + sort
  if (!hasPage) {
    throw TorobApiException.badRequest('page parameter is not provided');
  }

  if (!hasSort) {
    throw TorobApiException.badRequest('sort parameter is not provided');
  }

  if (
    typeof body.page !== 'number' ||
    !Number.isInteger(body.page) ||
    body.page < 1
  ) {
    throw TorobApiException.badRequest(
      'page must be an integer greater than or equal to 1',
    );
  }

  if (typeof body.sort !== 'string') {
    throw TorobApiException.badRequest('sort must be a string');
  }

  if (!TOROB_SORT_VALUES.includes(body.sort as never)) {
    throw TorobApiException.badRequest(
      `invalid sort value "${body.sort}"; allowed values are ${TOROB_SORT_VALUES.join(', ')}`,
    );
  }

  if (body.sort === 'product_id_desc') {
    throw TorobApiException.badRequest(
      'sort product_id_desc is only supported together with the cursor parameter',
    );
  }

  return {
    mode: 'page',
    page: body.page,
    sort: body.sort as TorobPageSort,
  };
}
