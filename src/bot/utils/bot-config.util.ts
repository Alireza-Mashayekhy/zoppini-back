import { BOT_DEFAULT_LOW_STOCK_THRESHOLD } from '../bot.constants';

/**
 * آیا این درخواست باید HTTPS باشد؟
 *
 * در production همیشه اجباری است. در محیط local/staging فقط وقتی
 * BOT_REQUIRE_TLS=true تنظیم شده باشد.
 */
export function isBotTlsEnforced(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }

  return (process.env.BOT_REQUIRE_TLS ?? '').trim().toLowerCase() === 'true';
}

export function isSecureHttpRequest(request: {
  secure?: boolean;
  protocol?: string;
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  if (request.secure === true || request.protocol === 'https') {
    return true;
  }

  const forwarded = request.headers['x-forwarded-proto'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;

  return (raw ?? '').split(',')[0].trim().toLowerCase() === 'https';
}

/**
 * آستانه‌ی پیش‌فرض کمبود موجودی برای ربات.
 * مقدار از env خوانده می‌شود؛ اگر نامعتبر باشد به ۳ برمی‌گردد.
 */
export function getDefaultLowStockThreshold(): number {
  const raw = (process.env.BOT_LOW_STOCK_THRESHOLD ?? '').trim();
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100000) {
    return BOT_DEFAULT_LOW_STOCK_THRESHOLD;
  }

  return parsed;
}
