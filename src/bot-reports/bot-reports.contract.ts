/**
 * قرارداد خروجی API گزارش‌های ربات مدیریتی بله (Bale).
 *
 * ربات (`bot/bot.mjs` در ریشهٔ پروژه) فقط همین فیلدها را می‌خواند؛ پس
 * adapter (`BotReportsService`) نباید Entity خام برگرداند و نباید دادهٔ
 * شخصی مشتری (نام، تلفن، ایمیل، آدرس، کد ملی و …) وارد این خروجی‌ها شود.
 * مستند کامل راه‌اندازی: `bot/README_FA.md`.
 */
export const BOT_REPORTS_READER = Symbol('BOT_REPORTS_READER');

/**
 * واحد مبالغ این گزارش‌ها.
 *
 * مبالغ فروشگاه (قیمت واریانت، `finalPrice` سفارش، تخفیف و کیف پول) در
 * دیتابیس به «تومان» ذخیره می‌شوند — برخلاف مبالغ راهکاران/باشگاه مشتریان
 * که ریالی‌اند و در فرانت‌اند با `rialToToman` تبدیل می‌شوند. برای همین
 * واحد قرارداد `IRT` (تومان) است و هیچ تبدیلی روی مبالغ انجام نمی‌شود.
 * اگر روزی واحد ذخیره‌سازی عوض شد، هم این ثابت و هم تبدیل مبلغ در
 * `BotReportsService` باید با هم تغییر کنند.
 */
export const BOT_REPORTS_CURRENCY = 'IRT' as const;

export type BotReportsCurrency = typeof BOT_REPORTS_CURRENCY;

export type DateRange = {
  /** تاریخ شروع بازه به شکل `YYYY-MM-DD` (شامل خود این روز) */
  from: string;
  /** تاریخ پایان بازه به شکل `YYYY-MM-DD` (شامل خود این روز) */
  to: string;
  timezone: 'Asia/Tehran';
};

export interface SalesSummary {
  from: string;
  to: string;
  timezone: 'Asia/Tehran';
  currency: BotReportsCurrency;
  /** تعداد سفارش‌های پرداخت‌شده (paid/shipped/delivered) در بازه */
  paidOrders: number;
  /** جمع `finalPrice` سفارش‌های پرداخت‌شده */
  grossSales: number;
  /**
   * مرجوعی/بازپرداخت در بازه. فعلاً موجودیت refund و زمان لغو در پروژه
   * ثبت نمی‌شود، پس مقدار قابل‌اتکایی برای آن وجود ندارد و `0` برمی‌گردد؛
   * در نتیجه `netSales` با `grossSales` برابر است.
   */
  refunds: number;
  netSales: number;
  averageOrderValue: number;
  generatedAt: string;
}

export interface LowStockReport {
  threshold: number;
  /**
   * تقریب زمان آخرین همگام‌سازی موجودی: بیشترین `updatedAt` واریانت‌ها
   * (سینک راهکاران همین فیلد را به‌روز می‌کند؛ ویرایش دستی هم اثر دارد).
   */
  inventorySyncedAt: string | null;
  items: Array<{
    productName: string;
    /** ترکیب رنگ/سایز واریانت؛ اگر هر دو خالی باشند `null` */
    variant: string | null;
    sku: string | null;
    stock: number;
  }>;
}

export interface BotOrder {
  orderNumber: string;
  /** وضعیت خام سفارش (`pending`/`paid`/`shipped`/`delivered`/`cancelled`)؛ برچسب فارسی سمت ربات ساخته می‌شود */
  status: string;
  createdAt: string;
  currency: BotReportsCurrency;
  total: number;
  items: Array<{
    productName: string;
    variant: string | null;
    quantity: number;
    unitPrice: number;
  }>;
}

export interface CustomerSummary {
  /** کاربرانی که در بازه ثبت‌نام کرده‌اند (بدون حساب‌های مدیر) */
  newCustomers: number;
  /**
   * مشتریانی که در بازه خرید پرداخت‌شده داشته‌اند و پیش از شروع بازه هم
   * دست‌کم یک خرید پرداخت‌شده داشته‌اند.
   */
  repeatCustomers: number;
}

export interface BotReportsReader {
  getSalesSummary(range: DateRange): Promise<SalesSummary>;

  getLowStock(input: { threshold: number }): Promise<LowStockReport>;

  getOrder(orderNumber: string): Promise<BotOrder | null>;

  getCustomerSummary(range: DateRange): Promise<CustomerSummary>;
}
