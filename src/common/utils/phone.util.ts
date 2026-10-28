/**
 * ابزارهای مشترک نرمال‌سازی شماره موبایل ایران.
 *
 * چرا لازم است؟
 * کاربر ممکن است شماره را با اعداد فارسی/عربی (۰۹۱۲…)، با فاصله یا خط‌تیره،
 * یا با پیش‌شماره بین‌المللی (+۹۸ / ۰۰۹۸ / ۹۸) وارد کند. اگر این ورودی‌ها
 * بدون یکدست‌سازی به دیتابیس/کلیدهای Redis بروند، هر حالت یک «کاربر» جدا و
 * یک کلید OTP جدا می‌سازد و کاربر بعداً با همان شماره پیدا نمی‌شود.
 */

/** نگاشت ارقام فارسی/عربی به لاتین */
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** قالب استاندارد داخلی: ۱۱ رقم و شروع با ۰۹ */
export const IRAN_MOBILE_REGEX = /^09\d{9}$/;

/** ارقام فارسی/عربی را به لاتین تبدیل می‌کند. */
export function toLatinDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, digit => {
    const persianIndex = PERSIAN_DIGITS.indexOf(digit);
    if (persianIndex > -1) return String(persianIndex);

    const arabicIndex = ARABIC_DIGITS.indexOf(digit);
    return arabicIndex > -1 ? String(arabicIndex) : digit;
  });
}

/**
 * شماره موبایل را به قالب یکدست `09xxxxxxxxx` تبدیل می‌کند.
 *
 * - ورودی غیر رشته/عدد (undefined، null، آبجکت و…) دست‌نخورده برگردانده می‌شود
 *   تا اعتبارسنجی‌های بعدی (IsNotEmpty / IsString) پیام درست بدهند.
 * - بدون بررسی «معتبر بودن» است؛ فقط قالب را یکدست می‌کند.
 */
export function normalizeIranMobile(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) {
    value = String(value);
  }

  if (typeof value !== 'string') {
    return value;
  }

  // ارقام فارسی/عربی + حذف فاصله، خط‌تیره، پرانتز و نقطه
  let digits = toLatinDigits(value).replace(/[\s\-()._]/g, '');

  // علامت مثبت ابتدای شماره بین‌المللی
  if (digits.startsWith('+')) {
    digits = digits.slice(1);
  }

  if (/^0098\d{10}$/.test(digits)) {
    // 00989123456789 → 09123456789
    digits = '0' + digits.slice(4);
  } else if (/^98\d{10}$/.test(digits)) {
    // 989123456789 → 09123456789
    digits = '0' + digits.slice(2);
  } else if (/^9\d{9}$/.test(digits)) {
    // 9123456789 → 09123456789
    digits = '0' + digits;
  }

  return digits;
}

/** آیا عدد/رشته‌ی ورودی یک شماره موبایل معتبر ایران است؟ */
export function isIranMobile(value: unknown): boolean {
  const normalized = normalizeIranMobile(value);
  return typeof normalized === 'string' && IRAN_MOBILE_REGEX.test(normalized);
}
