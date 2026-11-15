/**
 * منطقِ خالصِ بازنویسی لینک‌های قدیمی مقالات (`https://zoppinico.com/{slug}/`
 * به `/blog/{slug}`).
 *
 * این فایل عمداً **هیچ وابستگی خارجی ندارد** (نه typeorm، نه Nest) تا
 * بتوان روی آن تست نوشت و بدون بالا آوردن دیتابیس اجرایش کرد. اسکریپتِ
 * `rewrite-blog-body-links.ts` از همین توابع استفاده می‌کند.
 *
 * قوانین محدودکننده (برای جلوگیری از بازنویسیِ گسترده):
 * ۱. فقط میزبان‌های `zoppinico.com` و `www.zoppinico.com` (با http یا https)؛
 * ۲. فقط مسیرهای تک‌بخشی (`/{slug}` یا `/{slug}/`)؛
 * ۳. فقط اسلاگ‌هایی که واقعاً متعلق به یک مقاله‌ی موجود باشند؛
 * ۴. query string و hash حفظ می‌شوند؛
 * ۵. علائم نگارشیِ انتهای جمله (مثل `.` بعد از لینک) جزو آدرس نیستند.
 */

/** میزبان‌هایی که «لینک داخلی» محسوب می‌شوند. */
const INTERNAL_HOSTS = new Set(['zoppinico.com', 'www.zoppinico.com']);

/** آدرس‌های سایت در یک متن دلخواه (محدود به کاراکترهای مجازِ URL). */
const URL_PATTERN = /https?:\/\/(?:www\.)?zoppinico\.com\/[^\s"'<>)\]]*/gi;

export interface LinkReplacement {
  before: string;
  after: string;
}

/**
 * یک آدرسِ داخلی را — در صورت انطباق با اسلاگِ یک مقاله — به مسیر نسبی تبدیل
 * می‌کند؛ در غیر این صورت `null` برمی‌گرداند (یعنی نباید تغییر کند).
 */
export function rewriteBlogUrl(url: string, slugs: Set<string>): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!INTERNAL_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);

  // فقط مسیرهای تک‌بخشی: `/{slug}` یا `/{slug}/`
  if (segments.length !== 1) return null;

  let slug: string;

  try {
    slug = decodeURIComponent(segments[0]);
  } catch {
    return null;
  }

  // فقط اسلاگ‌های واقعیِ مقالات؛ هیچ اسلاگِ روتِ دلخواهی تغییر نمی‌کند.
  if (!slugs.has(slug)) return null;

  return `/blog/${slug}${parsed.search}${parsed.hash}`;
}

/**
 * اعمال بازنویسی روی یک رشته و جمع‌آوری diffِ قبل/بعد.
 */
export function rewriteLinksInText(
  text: string | null | undefined,
  slugs: Set<string>,
  replacements: LinkReplacement[] = [],
): { value: string; changed: boolean } {
  if (!text) return { value: text ?? '', changed: false };

  const seen = new Set(replacements.map(item => item.before));

  const value = text.replace(URL_PATTERN, match => {
    // علائم نگارشیِ انتهایی (مثل نقطه‌ی آخر جمله) جزو آدرس نیستند.
    const trimmed = match.replace(/[.,;:]+$/, '');
    const trailing = match.slice(trimmed.length);

    const after = rewriteBlogUrl(trimmed, slugs);

    if (!after) return match;

    const result = after + trailing;

    if (result !== match && !seen.has(match)) {
      seen.add(match);
      replacements.push({ before: match, after: result });
    }

    return result;
  });

  return { value, changed: value !== text };
}

/**
 * بازنویسی فیلدهای متنیِ داخل آیتم‌های JSON بلوک‌های مقاله.
 *
 * فقط فیلدهایی بررسی می‌شوند که می‌توانند لینک داخلی داشته باشند:
 * `html`، `linkUrl` و `url`.
 */
export function rewriteLinksInBlockItems(
  items: Record<string, unknown>[] | null | undefined,
  slugs: Set<string>,
  replacements: LinkReplacement[] = [],
): { value: Record<string, unknown>[] | null; changed: boolean } {
  if (!items?.length) return { value: items ?? null, changed: false };

  let changed = false;

  const value = items.map(item => {
    const next: Record<string, unknown> = { ...item };

    for (const key of ['html', 'linkUrl', 'url']) {
      const current = next[key];

      if (typeof current !== 'string') continue;

      const result = rewriteLinksInText(current, slugs, replacements);

      if (result.changed) {
        next[key] = result.value;
        changed = true;
      }
    }

    return next;
  });

  return { value, changed };
}
