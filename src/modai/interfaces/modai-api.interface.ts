/**
 * اینترفیس‌های درگاه مدآی (ModAI) نسخه ۱
 *
 * مستند: لیست کل محصولات
 *   POST https://<domain>/modai-api/v1/products
 */

/** مقدار ثابت فیلد `api_version` در تمام پاسخ‌ها */
export const MODAI_API_VERSION = 'v1';

/** تعداد محصول در هر صفحه (الزامی مدآی — ۱۰۰ محصول در هر صفحه) */
export const MODAI_PAGE_SIZE = 100;

/** مقادیر مجاز پارامتر `sort` */
export const MODAI_SORT_VALUES = [
  'date_added_desc',
  'date_updated_desc',
] as const;

export type ModaiSort = (typeof MODAI_SORT_VALUES)[number];

/**
 * حداکثر تعداد `product_unique` در یک درخواست products-by-uniques
 * (مستند محدودیتی تعیین نکرده است)
 */
export const MODAI_MAX_LOOKUP_UNIQUES = 1000;

/** حداکثر تعداد تصویر ارسالی برای هر محصول */
export const MODAI_MAX_IMAGE_LINKS = 20;

/** درخواست پارس‌شده */
export interface ModaiParsedRequest {
  page: number;
  sort: ModaiSort;
  /** کلیدهای ناشناختهٔ body — برای لاگ، نه برای خطا دادن */
  unknownKeys: string[];
}

/** یک ویژگی سطح تنوع (مثل رنگ یا سایز یک تنوع مشخص) */
export interface ModaiVariantAttribute {
  id: string;
  title: string;
  option: string;
}

/** یک ویژگی سطح محصول (مثل همهٔ رنگ‌های یک محصول) */
export interface ModaiProductAttribute {
  id: string;
  title: string;
  options: string[];
}

export interface ModaiCategory {
  id: string;
  title: string;
}

export interface ModaiVariant {
  id: string;
  quantity: number;
  price: number;
  old_price: number;
  /** در نبود تصویر برای این تنوع، رشتهٔ خالی (مطابق نمونهٔ مستند) */
  image_link: string;
  attributes: ModaiVariantAttribute[];
}

export interface ModaiSizeGuideTable {
  headers: string[];
  rows: string[][];
}

export interface ModaiSizeGuide {
  text: string;
  image_link: string;
  table: ModaiSizeGuideTable | null;
}

export interface ModaiProduct {
  /** حداکثر ۲۰۰ کاراکتر — شناسهٔ یکتا و ثابت محصول */
  product_unique: string;

  /** حداکثر ۱۵۰۰ کاراکتر — آدرس مطلق صفحهٔ محصول */
  product_url: string;

  /** iso8601 همراه با timezone */
  date_added: string;

  /** iso8601 همراه با timezone */
  date_updated: string;

  /** حداکثر ۵۰۰ کاراکتر */
  sku: string | null;

  /** حداکثر ۵۰۰ کاراکتر */
  title: string;

  description: string;

  /** آدرس‌های مطلق — اولین تصویر باید تصویر اصلی محصول باشد */
  image_links: string[];

  categories: ModaiCategory[];

  variants: ModaiVariant[];

  /**
   * اختیاری در مستند مدآی؛ همیشه آرایه فرستاده می‌شود (خالی یعنی نداریم)
   * تا مصرف‌کننده با مقدار null روبه‌رو نشود.
   */
  attributes: ModaiProductAttribute[];

  /** اختیاری در مستند مدآی — فعلاً در زوپینی تگ نداریم، پس آرایهٔ خالی */
  tags: string[];

  /** اختیاری در مستند مدآی */
  size_guide: ModaiSizeGuide | null;
}

export interface ModaiResponse {
  api_version: string;
  current_page: number;
  total: number;
  max_pages: number;
  products: ModaiProduct[];
}
