import type { Request } from 'express';

/**
 * گرفتن IP واقعی کاربر.
 *
 * در مستندات تارا فیلد `ip` اجباری است و کدهای خطای
 * «1 = درخواست از IP غیر مجاز» و «88 = IP نمی تواند خالی باشد»
 * مستقیماً به آن مربوط می‌شوند؛ پس نباید مقدار ثابت فرستاد.
 *
 * اگر سرویس پشت پروکسی معکوس / CDN است، IP واقعی در X-Forwarded-For
 * (اولین مقدار) قرار دارد.
 */
export function getClientIp(req?: Request | null): string {
  if (!req) {
    return '';
  }

  const forwarded = req.headers?.['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;

  if (typeof forwardedValue === 'string' && forwardedValue.trim()) {
    const first = forwardedValue.split(',')[0]?.trim();

    if (first) {
      return first;
    }
  }

  const realIp = req.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  return req.ip || req.socket?.remoteAddress || '';
}
