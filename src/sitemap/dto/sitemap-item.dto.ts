export class SitemapItemDto {
  name: string;

  slug: string;

  /**
   * زمان واقعیِ آخرین تغییر رکورد (ISO 8601).
   *
   * اگر مقدار معتبری نداشته باشیم `null` است؛ فرانت‌اند در این حالت تگ
   * `<lastmod>` را کلاً حذف می‌کند و هرگز زمان درخواست را جایگزین نمی‌کند.
   */
  updatedAt: string | null;
}
