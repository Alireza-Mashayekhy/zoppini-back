/**
 * ساخت آدرس عمومی callback درگاه‌های پرداخت.
 *
 * تنها جایی که آدرس بازگشت درگاه‌ها ساخته می‌شود همین فایل است تا همهٔ
 * درگاه‌ها یک قاعدهٔ واحد داشته باشند.
 *
 * باگ واقعی که این فایل جلوی آن را می‌گیرد: در این پروژه بیشتر متغیرهای
 * «آدرس سایت» با پیشوند `/api` تنظیم می‌شوند (مثل `NEXT_PUBLIC_API_URL` یا
 * آدرس داخلی Nest). اگر `APP_URL` هم همان شکل باشد، الحاق سادهٔ
 * `/api/payment/callback/...` آدرس تکراری
 * `https://site/api/api/payment/callback/...` می‌سازد که به هیچ مسیری
 * نمی‌خورد؛ درگاه مبلغ را می‌گیرد ولی callback گم می‌شود.
 */

const API_PREFIX = '/api';

/**
 * جمع کردن `/api` تکراری در مسیر:
 * `https://site/api/api/payment/x` → `https://site/api/payment/x`
 */
export function collapseDuplicateApiSegment(url: string): string {
  return url.replace(/\/api(?:\/api)+(?=\/|$)/gi, API_PREFIX);
}

/**
 * آدرس پایهٔ عمومی (origin سایت) بدون اسلش انتهایی و بدون `/api` انتهایی.
 * مقدارهای خالی `''` برمی‌گردانند تا فراخوان بتواند خطای پیکربندی بدهد.
 */
export function normalizePublicBaseUrl(raw: string | null | undefined): string {
  let value = String(raw ?? '').trim();

  if (!value) {
    return '';
  }

  value = collapseDuplicateApiSegment(value);
  value = value.replace(/\/+$/, '');

  // اگر آدرس پایه خودش با /api داده شده باشد (آدرس API نه origin سایت)
  value = value.replace(/\/api$/i, '');

  return value;
}

/**
 * الحاق یک مسیر بعد از پیشوند `/api`.
 * `pathAfterApi` نباید `/api` داشته باشد؛ مثلاً `payment/callback/snappay`.
 */
export function buildApiUrl(
  baseUrl: string | null | undefined,
  pathAfterApi: string,
): string {
  const base = normalizePublicBaseUrl(baseUrl);

  if (!base) {
    return '';
  }

  const path = String(pathAfterApi ?? '').replace(/^\/+|\/+$/g, '');

  return path ? `${base}${API_PREFIX}/${path}` : `${base}${API_PREFIX}`;
}

/**
 * آدرس نهایی callback یک درگاه.
 *
 * ترتیب: مقدار صریح همان درگاه ← آدرس پایه (`APP_URL`/`FRONT_URL`).
 * در هر دو حالت `/api` تکراری جمع می‌شود تا آدرس ارسالی به درگاه همیشه
 * یک `/api` داشته باشد. اگر هیچ‌کدام تنظیم نشده باشد `''` برمی‌گردد.
 */
export function resolveGatewayCallbackUrl(params: {
  explicit?: string | null;
  baseUrl?: string | null;
  /** مسیر بعد از `/api`، مثلاً `payment/callback/snappay` */
  pathAfterApi: string;
}): string {
  const explicit = String(params.explicit ?? '').trim();

  if (explicit) {
    return collapseDuplicateApiSegment(explicit).replace(/\/+$/, '');
  }

  return buildApiUrl(params.baseUrl, params.pathAfterApi);
}
