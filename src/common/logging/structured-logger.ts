import { randomUUID } from 'crypto';

/**
 * لاگ‌گذاری ساختاریافته (Structured Logging) برای فرآیندهای یکپارچه‌سازی
 * (دایاتک / راهکاران / پرداخت).
 *
 * خروجی هر لاگ یک JSON یک‌خطی است که توسط `Logger` نست با context و سطح
 * مناسب چاپ می‌شود، بنابراین در Production می‌توان با جستجوی یک
 * `correlationId` تمام گام‌های یک درخواست را پیدا کرد:
 *
 *   {"event":"rahkaran.invoice.sync.start","correlationId":"rah-inv-...","orderId":123,...}
 *
 * قواعد:
 * - اطلاعات حساس (رمز، توکن، کوکی، API Key) هرگز لاگ نمی‌شوند؛ کلیدهای
 *   مشکوک به‌صورت خودکار Mask می‌شوند.
 * - رشته‌های خیلی طولانی کوتاه می‌شوند تا حجم لاگ کنترل شود.
 * - شماره موبایل با maskMobile ماسک می‌شود.
 */

export type StructuredLogFields = Record<string, unknown>;

/** شناسهٔ ردیابی یکتا برای یک فرآیند (مثلاً ثبت فاکتور یک سفارش). */
export function createCorrelationId(prefix = 'req'): string {
  return `${prefix}-${randomUUID()}`;
}

const SENSITIVE_KEY_PATTERN =
  /pass(word)?|secret|token|api[-_]?key|authorization|cookie|encrypted|session[-_]?id|^otp([-_]?code)?$|^verification[-_]?code$/i;

const MAX_STRING_LENGTH = 1000;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 5;

/**
 * کپی امن از یک مقدار برای لاگ: کلیدهای حساس با `***` جایگزین می‌شوند و
 * رشته‌های بلند کوتاه می‌شوند.
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateForLog(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (depth >= MAX_DEPTH) {
    return '[truncated:max-depth]';
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => sanitizeForLog(item, depth + 1));

    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[truncated: ${value.length - MAX_ARRAY_ITEMS} more items]`);
    }

    return items;
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? '***'
        : sanitizeForLog(item, depth + 1);
    }

    return result;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  // function/symbol و انواع غیرقابل serialize
  return Object.prototype.toString.call(value);
}

export function truncateForLog(value: string, max = MAX_STRING_LENGTH): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

/**
 * ماسک شماره موبایل برای لاگ: حفظ ۴ رقم اول و ۳ رقم آخر.
 * مثال: 09123456789 -> 0912****789
 */
export function maskMobile(phone: string | null | undefined): string | null {
  if (!phone) {
    return null;
  }

  const normalized = String(phone).trim();

  if (normalized.length < 8) {
    return '***';
  }

  return `${normalized.slice(0, 4)}****${normalized.slice(-3)}`;
}

export interface SerializedError {
  type: string;
  message: string;
  errorCode?: string | number;
  stack?: string;
  /** کد وضعیت HTTP در صورت خطای Axios یا HttpException */
  httpStatus?: number;
  /** خلاصهٔ بدنهٔ پاسخ upstream در صورت وجود */
  httpResponseBody?: string;
}

/**
 * تبدیل Error (از جمله AxiosError / HttpException / QueryFailedError) به ساختار
 * قابل لاگ؛ بدون افشای هدرها/توکن‌ها.
 */
export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return {
      type: 'UnknownError',
      message: truncateForLog(String(error)),
    };
  }

  const serialized: SerializedError = {
    type: error.constructor?.name || 'Error',
    message: truncateForLog(error.message || 'unknown error'),
  };

  const extended = error as {
    response?: { status?: number; data?: unknown };
    isAxiosError?: boolean;
    code?: string | number;
    errno?: number;
    status?: number;
    getStatus?: () => number;
    driverError?: { code?: string; errno?: number };
  };

  const httpStatus =
    extended?.response?.status ??
    (typeof extended?.getStatus === 'function'
      ? extended.getStatus()
      : extended?.status);

  if (httpStatus !== undefined) {
    serialized.httpStatus = httpStatus;
  }

  const errorCode =
    extended?.code ??
    extended?.driverError?.code ??
    extended?.errno ??
    extended?.driverError?.errno ??
    httpStatus;

  if (errorCode !== undefined) {
    serialized.errorCode = errorCode;
  }

  if (extended?.response?.data !== undefined) {
    serialized.httpResponseBody = truncateForLog(
      stringifySafe(extended.response.data),
      500,
    );
  }

  if (typeof extended?.code === 'string') {
    // کدهای شبکه‌ای و دیتابیسی مانند ETIMEDOUT / ECONNREFUSED / ER_BAD_FIELD_ERROR
    serialized.type = `${serialized.type}(${extended.code})`;
  }

  return serialized;
}

export function stringifySafe(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * ساخت پیام لاگ ساختاریافته: همیشه `event` اولین کلید است تا خوانایی حفظ شود.
 */
export function structuredLog(
  event: string,
  fields: StructuredLogFields = {},
): string {
  const payload: StructuredLogFields = { event };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }

    payload[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '***'
      : sanitizeForLog(value);
  }

  return stringifySafe(payload);
}
