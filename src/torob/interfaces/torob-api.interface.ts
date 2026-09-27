/**
 * اینترفیس‌های درگاه TorobAPI نسخه ۳
 * منبع: https://panel.torob.com/s/torobApiV3
 */

/** مقدار ثابت فیلد `api_version` در تمام پاسخ‌ها */
export const TOROB_API_VERSION = 'torob_api_v3';

/** تعداد محصول در هر صفحه (الزامی ترب) */
export const TOROB_PAGE_SIZE = 100;

/** مقادیر مجاز برای پارامتر `sort` */
export const TOROB_SORT_VALUES = [
  'date_added_desc',
  'date_updated_desc',
  'product_id_desc',
] as const;

export type TorobSort = (typeof TOROB_SORT_VALUES)[number];

/** فقط این دو مقدار با `page` (صفحه‌بندی بر اساس شماره صفحه) مجاز هستند */
export type TorobPageSort = Extract<
  TorobSort,
  'date_added_desc' | 'date_updated_desc'
>;

/**
 * یک محصول (در این پیاده‌سازی: یک تنوع/واریانت مشخص از محصول)
 * دقیقاً مطابق ساختار تعریف‌شده در مستند ترب.
 */
export interface TorobProduct {
  /** حداکثر ۲۰۰ کاراکتر - شناسه یکتا و ثابت محصول */
  page_unique: string;

  /** حداکثر ۱۵۰۰ کاراکتر - آدرس مطلق صفحه محصول */
  page_url: string;

  /** حداکثر ۵۰۰ کاراکتر - عنوان محصول */
  title: string;

  /** حداکثر ۵۰۰ کاراکتر */
  subtitle: string | null;

  /** حداکثر ۲۰۰ کاراکتر - شناسه گروه برای ادغام تنوع‌های یک محصول */
  product_group_id: string | null;

  /** نوع این فیلد برای همه محصولات باید int باشد و هرگز null نمی‌شود */
  current_price: number;

  old_price: number | null;

  availability: boolean;

  /** حداکثر ۲۰۰ کاراکتر */
  category_name: string | null;

  /** حداقل یک آدرس مطلق - تصویر اصلی باید اول باشد */
  image_links: string[];

  /** حداکثر ۵۰۰ کاراکتر */
  short_desc: string | null;

  /** اجباری - برای محصولات بدون جدول مشخصات باید `{}` باشد */
  spec: Record<string, string | number>;

  /** حداکثر ۲۰۰ کاراکتر */
  guarantee: string | null;

  /** iso8601 همراه با timezone */
  date_added: string;

  /** iso8601 همراه با timezone */
  date_updated: string;

  seller_name: string | null;
  seller_city: string | null;
}

/** پاسخ نهایی درگاه */
export interface TorobResponse {
  api_version: typeof TOROB_API_VERSION;
  current_page: number;
  total: number | null;
  max_pages: number | null;
  next_cursor: string | null;
  products: TorobProduct[];
}

/** فرمت خطای ترب */
export interface TorobErrorResponse {
  error: string;
}

/** حالت‌های مجاز درخواست (دقیقاً یکی از این‌ها باید در body باشد) */
export type TorobRequestMode = 'page' | 'cursor' | 'page_uniques' | 'page_urls';

/** body پارس‌شده و اعتبارسنجی‌شده */
export interface TorobParsedRequest {
  mode: TorobRequestMode;

  // برای حالت page
  page?: number;

  // برای حالت page مقدار `product_id_desc` مجاز نیست
  sort?: TorobSort;

  // برای حالت cursor
  cursor?: TorobCursor;

  // برای حالت‌های تکی
  pageUniques?: string[];
  pageUrls?: string[];
}

export interface TorobCursor {
  /** شناسه آخرین واریانت این صفحه */
  lastVariantId: number;

  /** شماره صفحه‌ای که این cursor از آن ساخته شده (برای fill کردن current_page) */
  page: number;
}
