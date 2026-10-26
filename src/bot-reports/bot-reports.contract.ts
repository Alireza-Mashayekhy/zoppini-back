import { BotOperatorRole } from './entities/bot-operator.entity';
import {
  BotEventType,
  BotNotificationCategory,
  BotOutboxStatus,
} from './entities/bot-outbox-event.entity';
import {
  BotSyncRunStatus,
  BotSyncStatsSnapshot,
} from './entities/bot-setting.entity';

/**
 * قرارداد خروجی API ربات مدیریتی بله (`/api/bot/v1/...`).
 *
 * تمام پاسخ‌ها DTOهای صریح و کمینه هستند؛ هیچ Entity خام دیتابیس، کد ملی،
 * هش رمز، دادهٔ خام درگاه پرداخت، IP یا User-Agent هرگز برگردانده نمی‌شود.
 */
export const BOT_REPORTS_READER = Symbol('BOT_REPORTS_READER');

/**
 * مبالغ سفارش، اقلام، تخفیف، ارسال و کیف پول در دیتابیس به «تومان» ذخیره می‌شوند.
 * مبالغ جدول `payments` درگاه ریالی‌اند و هنگام تجمیع صریحاً بر ۱۰ تقسیم می‌شوند.
 */
export const BOT_REPORTS_CURRENCY = 'IRT' as const;
export const BOT_REPORTS_CURRENCY_LABEL = 'تومان' as const;
export const BOT_REPORTS_TIMEZONE = 'Asia/Tehran' as const;

export type BotReportsCurrency = typeof BOT_REPORTS_CURRENCY;

export type BotPermission =
  | 'orders:summary'
  | 'orders:read'
  | 'orders:customer_pii'
  | 'sales:read'
  | 'sales:export'
  | 'customers:read'
  | 'inventory:read'
  | 'inventory:export'
  | 'alerts:read'
  | 'alerts:manage'
  | 'settings:read'
  | 'settings:write'
  | 'roles:manage';

export type DateRange = {
  from: string;
  to: string;
  timezone: typeof BOT_REPORTS_TIMEZONE;
};

export interface BotCallerProfileDto {
  authorized: boolean;
  baleUserId: string;
  role: BotOperatorRole | null;
  permissions: BotPermission[];
}

export interface OrdersTodaySummaryDto {
  date: string;
  timezone: typeof BOT_REPORTS_TIMEZONE;
  totalOrders: number;
  categories: {
    /** سفارش‌های جدید / در انتظار پرداخت (`status = 'pending'`) */
    pending: number;
    /** سفارش‌های پرداخت‌شده و آمادهٔ پردازش/ارسال (`status = 'paid'`) */
    paid: number;
    /** سفارش‌های در حال ارسال / تحویل به پست یا پیک (`status = 'shipped'`) */
    shipped: number;
    /** سفارش‌های تحویل‌شده به مشتری (`status = 'delivered'`) */
    delivered: number;
    /** سفارش‌های لغوشده (`status = 'cancelled'`) */
    cancelled: number;
    /**
     * در `OrderStatus` وضعیت مجزای `refunded`/`returned` تعریف نشده است؛
     * این فیلد سفارش‌های امروز را نشان می‌دهد که پس از پرداخت لغو شده یا
     * برایشان تراکنش عودت کیف‌پول (`wallet_transactions.type = 'refund'`) ثبت شده است.
     */
    refundedOrCancelledAfterPayment: number;
  };
  statusDefinitions: {
    pending: string;
    paid: string;
    shipped: string;
    delivered: string;
    cancelled: string;
    refundedNote: string;
  };
  generatedAt: string;
}

export interface BotOrderListItemDto {
  orderNumber: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  finalPrice: number;
  itemsCount: number;
  currency: BotReportsCurrency;
}

export interface PaginatedOrdersDto {
  items: BotOrderListItemDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  filters: {
    status: string | null;
    from: string | null;
    to: string | null;
  };
  currency: BotReportsCurrency;
  timezone: typeof BOT_REPORTS_TIMEZONE;
}

export interface BotOrderCustomerSummaryDto {
  fullName: string;
  province: string | null;
  city: string | null;
}

export interface BotOrderCustomerPiiDto {
  fullName: string;
  phone: string;
  province: string | null;
  city: string | null;
  address: string | null;
  postalCode: string | null;
}

export interface BotOrderDetailDto {
  orderNumber: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  currency: BotReportsCurrency;
  shippingMethod: string | null;
  itemsSubtotal: number;
  saleDiscount: number;
  discount: number;
  shippingCost: number;
  walletPayment: number;
  gatewayPaidAmount: number;
  refundedAmount: number;
  /** مبلغ نهایی سفارش (`finalPrice`) — نام فیلد `total` هم برای سازگاری حفظ شده است */
  finalPrice: number;
  total: number;
  items: Array<{
    productName: string;
    variant: string | null;
    color: string | null;
    size: string | null;
    sku: string | null;
    quantity: number;
    originalUnitPrice: number | null;
    unitPrice: number;
    lineTotal: number;
  }>;
  canViewCustomer: boolean;
  customerAccessDenied: boolean;
  customerSummary: BotOrderCustomerSummaryDto | null;
  customer: BotOrderCustomerPiiDto | null;
}

export interface DailySalesPointDto {
  date: string;
  paidOrders: number;
  netSales: number;
  finalPaidTotal: number;
}

export interface SalesSummary {
  from: string;
  to: string;
  timezone: typeof BOT_REPORTS_TIMEZONE;
  currency: BotReportsCurrency;
  currencyLabel: typeof BOT_REPORTS_CURRENCY_LABEL;
  /** کل سفارش‌های ثبت‌شده در بازه (تمام وضعیت‌ها، بدون سفارش‌های تست) */
  totalOrders: number;
  /** سفارش‌های دارای پرداخت موفقِ نهایی (`paid` / `shipped` / `delivered`) */
  paidOrders: number;
  pendingOrders: number;
  cancelledOrders: number;
  /** سفارش‌هایی که پس از پرداخت یا کسر کیف‌پول لغو/عودت شده‌اند */
  refundedOrders: number;
  /** فروش ناخالص اقلام (قبل از تخفیف و بدون هزینهٔ ارسال) */
  grossSales: number;
  /** مجموع تخفیف‌های اعمال‌شده روی سفارش‌های پرداخت‌شده */
  discounts: number;
  /** مبالغ عودت‌یافته / سفارش‌های پرداخت‌شده‌ای که لغو شده‌اند */
  refunds: number;
  /** فروش خالص اقلام (`grossSales - discounts - refunds`، بدون هزینهٔ ارسال) */
  netSales: number;
  /** جمع هزینهٔ ارسال سفارش‌های پرداخت موفق (جدا از فروش اقلام برای جلوگیری از دوباره‌شماری) */
  shippingTotal: number;
  /** جمع مبلغ نهایی سفارش‌های پرداخت موفق شامل هزینهٔ ارسال (`finalPrice`) */
  finalPaidTotal: number;
  /** میانگین فروش خالص هر سفارش موفق */
  averageOrderValue: number;
  /** میانگین مبلغ نهایی هر سفارش موفق (شامل ارسال) */
  averageFinalOrderValue: number;
  dailyBreakdown: DailySalesPointDto[];
  generatedAt: string;
}

export interface InventorySyncHealthDto {
  status: BotSyncRunStatus;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  isStale: boolean;
  staleThresholdHours: number;
  fallbackVariantUpdatedAt: string | null;
  stats: BotSyncStatsSnapshot | null;
}

export interface InventorySummaryDto {
  /** معیار شمارش موجودی: واریانت محصول (`variant.stock`) */
  countingUnit: 'variant';
  stockField: 'variant.stock';
  threshold: number;
  totalProducts: number;
  totalVariants: number;
  outOfStockVariants: number;
  lowStockVariants: number;
  inStockVariants: number;
  sync: InventorySyncHealthDto;
  generatedAt: string;
}

export type InventoryCategoryFilter = 'out' | 'low' | 'in' | 'all';

export interface InventoryItemDto {
  variantId: number;
  productId: number;
  productCode: string | null;
  productName: string;
  variant: string | null;
  color: string | null;
  size: string | null;
  sku: string | null;
  stock: number;
  price: number;
  updatedAt: string | null;
}

export interface PaginatedInventoryDto {
  countingUnit: 'variant';
  category: InventoryCategoryFilter;
  query: string | null;
  threshold: number;
  items: InventoryItemDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  sync: InventorySyncHealthDto;
  currency: BotReportsCurrency;
}

export interface LowStockReport {
  threshold: number;
  countingUnit: 'variant';
  inventorySyncedAt: string | null;
  sync: InventorySyncHealthDto;
  items: Array<{
    productName: string;
    variant: string | null;
    sku: string | null;
    stock: number;
  }>;
}

export interface CustomerSummary {
  from: string;
  to: string;
  timezone: typeof BOT_REPORTS_TIMEZONE;
  newCustomers: number;
  activeBuyers: number;
  repeatCustomers: number;
  firstTimeBuyers: number;
  generatedAt: string;
}

export interface CsvExportResult {
  filename: string;
  totalRecords: number;
  generatedAt: string;
  csvContent: string;
}

export interface BotSettingsDto {
  lowStockThreshold: number;
  notifyOrderCreated: boolean;
  notifyOrderPaid: boolean;
  notifyOrderCancelled: boolean;
  notifyOrderStatusChanged: boolean;
  notifyInventoryAlerts: boolean;
  notifySyncAndHealth: boolean;
  inventoryReminderHours: number;
  staleSyncThresholdHours: number;
  updatedByBaleId: string | null;
  updatedAt: string | null;
  sync: InventorySyncHealthDto;
}

export interface BotOperatorDto {
  baleUserId: string;
  role: BotOperatorRole;
  label: string | null;
  isActive: boolean;
  isEnvPinned: boolean;
  receiveOrderAlerts: boolean;
  receiveInventoryAlerts: boolean;
  receiveHealthAlerts: boolean;
  updatedAt: string | null;
}

export interface BotLeasedEventDto {
  eventId: string;
  eventType: BotEventType;
  category: BotNotificationCategory;
  payload: Record<string, unknown>;
  recipients: string[];
  leaseToken: string;
  leasedUntil: string;
  attempts: number;
  createdAt: string;
}

export interface BotOutboxSummaryDto {
  pending: number;
  leased: number;
  deliveredLast24h: number;
  failed: number;
  skippedLast24h: number;
  oldestPendingAt: string | null;
}

export interface BotOutboxEventViewDto {
  eventId: string;
  eventType: BotEventType;
  category: BotNotificationCategory;
  status: BotOutboxStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  deliveredAt: string | null;
}

export interface BotSystemHealthDto {
  ok: boolean;
  database: 'up' | 'down';
  sync: InventorySyncHealthDto;
  outbox: BotOutboxSummaryDto;
  checkedAt: string;
  timezone: typeof BOT_REPORTS_TIMEZONE;
}

export interface BotReportsReader {
  getOrdersTodaySummary(date: string): Promise<OrdersTodaySummaryDto>;

  listOrders(input: {
    page: number;
    limit: number;
    status?: string;
    from?: string;
    to?: string;
  }): Promise<PaginatedOrdersDto>;

  getOrderDetail(
    orderNumber: string,
    options: { canViewCustomer: boolean; includeCustomer: boolean },
  ): Promise<BotOrderDetailDto | null>;

  getSalesSummary(range: DateRange): Promise<SalesSummary>;

  exportSalesCsv(range: DateRange): Promise<CsvExportResult>;

  getInventorySummary(): Promise<InventorySummaryDto>;

  listInventory(input: {
    category: InventoryCategoryFilter;
    query?: string;
    threshold?: number;
    page: number;
    limit: number;
  }): Promise<PaginatedInventoryDto>;

  exportInventoryCsv(input: {
    category: InventoryCategoryFilter;
    query?: string;
    threshold?: number;
  }): Promise<CsvExportResult>;

  getLowStock(input: { threshold: number }): Promise<LowStockReport>;

  getCustomerSummary(range: DateRange): Promise<CustomerSummary>;
}
