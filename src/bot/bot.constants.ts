export const BOT_API_KEY_HEADER = 'x-bot-api-key';
export const BOT_TELEGRAM_USER_HEADER = 'x-bot-telegram-user-id';
export const BOT_CHAT_TYPE_HEADER = 'x-bot-chat-type';

/**
 * گزارش‌ها همیشه با همین منطقه زمانی محاسبه می‌شوند.
 * مرز روزها در Asia/Tehran است، نه UTC و نه timezone سرور.
 */
export const BOT_TIME_ZONE = 'Asia/Tehran';

/**
 * مبلغ سفارش‌ها در دیتابیس تومان است (پنل مدیر هم همان را «تومان» نشان می‌دهد)
 * و مبلغ Payment در درگاه ریال است و هنگام ساخت درخواست در ۱۰ ضرب می‌شود.
 * این دو واحد عمداً جدا نگه داشته می‌شوند تا در گزارش با هم جمع نشوند.
 */
export const BOT_ORDER_CURRENCY = 'IRT';
export const BOT_ORDER_CURRENCY_UNIT = 'toman';
export const BOT_PAYMENT_CURRENCY_UNIT = 'rial';

export const BOT_DEFAULT_LOW_STOCK_THRESHOLD = 3;
export const BOT_MAX_DATE_RANGE_DAYS = 366;
export const BOT_DEFAULT_PAGE_SIZE = 20;
export const BOT_MAX_PAGE_SIZE = 50;

export enum BotRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  REPORTS_READONLY = 'reports_readonly',
  ORDERS_READONLY = 'orders_readonly',
}

export enum BotScope {
  REPORTS = 'reports',
  ORDERS = 'orders',
  INVENTORY = 'inventory',
}

/**
 * نقش‌ها از قبل تعریف شده‌اند تا افزودن افراد در آینده فقط با تنظیم
 * متغیرهای محیطی انجام شود و نیاز به تغییر کد نباشد.
 */
export const BOT_ROLE_SCOPES: Record<BotRole, BotScope[]> = {
  [BotRole.OWNER]: [BotScope.REPORTS, BotScope.ORDERS, BotScope.INVENTORY],
  [BotRole.ADMIN]: [BotScope.REPORTS, BotScope.ORDERS, BotScope.INVENTORY],
  [BotRole.REPORTS_READONLY]: [BotScope.REPORTS],
  [BotRole.ORDERS_READONLY]: [BotScope.ORDERS],
};
