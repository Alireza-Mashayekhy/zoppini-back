// src/rahkaran/rahkaran-stock.service.ts
//
// بررسی «لحظه‌ای» موجودی از راهکاران در دو نقطهٔ خرید:
//   ۱. افزودن به سبد / افزایش تعداد در سبد
//   ۲. نهایی‌کردن خرید (ثبت سفارش) و درست پیش از انتقال به درگاه
//
// این سرویس اتصال جدیدی به راهکاران نمی‌سازد؛ فقط از دو متد موجود
// `RahkaranService` استفاده می‌کند (همان‌هایی که ثبت فاکتور و Sync روزانه
// استفاده می‌کنند):
//   - getRetailProductByBarcode(sku)    → شناسهٔ کالای راهکاران
//   - getRemainingQuantityInfo(id)      → مانده به تفکیک انبار
// و قاعدهٔ موجود «موجودی قابل فروش سایت = هدیش‌مال + خرده‌فروشی» را با همان
// تابع `extractBothWarehouseStocks` اعمال می‌کند.

import {
  ConflictException,
  forwardRef,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  BotEventsService,
  VariantStockChangeInput,
} from 'src/bot-reports/bot-events.service';
import {
  createCorrelationId,
  serializeError,
  structuredLog,
} from 'src/common/logging/structured-logger';
import { OrderStatus } from 'src/order/entities/order.entity';
import { OrderItem } from 'src/order/entities/order-item';
import { Variant } from 'src/products/entities/variant.entity';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import {
  RahkaranInvoiceSync,
  RahkaranInvoiceSyncStatus,
} from './entities/rahkaran-invoice-sync.entity';
import {
  extractBothWarehouseStocks,
  HADISH_MALL_WAREHOUSE_ID,
  RahkaranLogContext,
  RahkaranRemainingQuantity,
  RahkaranService,
  RETAIL_WAREHOUSE_ID,
} from './rahkaran.service';

// ============================================================
// Public types
// ============================================================

export const STOCK_ERROR_CODES = {
  INSUFFICIENT: 'INSUFFICIENT_STOCK',
  UNAVAILABLE: 'STOCK_CHECK_UNAVAILABLE',
} as const;

export type StockCheckStage =
  | 'add_to_cart'
  | 'update_cart'
  | 'checkout'
  | 'payment_start'
  | 'wallet_confirm';

export interface StockRequirementLine {
  variantId: number;
  quantity: number;
}

export interface StockCheckOptions {
  stage: StockCheckStage;
  /**
   * سفارش‌های PENDING همین کاربر «رزرو نرم» حساب نمی‌شوند (سفارشی که خودش
   * در حال پرداخت آن است نباید جلوی خودش را بگیرد).
   */
  excludeUserId?: number;
  orderId?: number;
  correlationId?: string;
}

/** یک قلم ناکافی برای نمایش به کاربر */
export interface StockShortage {
  variantId: number;
  productId: number | null;
  productTitle: string;
  variantLabel: string | null;
  requested: number;
  available: number;
}

export interface VariantStockResult {
  variantId: number;
  sku: string;
  rahkaranProductId: number;
  hadishMall: number;
  retail: number;
  /** جمع خام دو انبار طبق پاسخ راهکاران */
  rahkaranTotal: number;
  /** اقلام سفارش‌های پرداخت‌شده که هنوز فاکتورشان در راهکاران ثبت نشده */
  paidNotInvoiced: number;
  /** اقلام سفارش‌های در انتظار پرداختِ اخیرِ سایر مشتریان */
  softReserved: number;
  /** موجودی‌ای که در ستون `variant.stock` نوشته می‌شود */
  siteStock: number;
  /** موجودی قابل خرید برای این درخواست */
  available: number;
  requested: number;
  sufficient: boolean;
}

export interface StockVerificationResult {
  ok: boolean;
  shortages: StockShortage[];
  results: VariantStockResult[];
  /** true یعنی بررسی با راهکاران انجام شد (نه حالت غیرفعال) */
  verifiedWithRahkaran: boolean;
}

/**
 * موجودی قابل‌اعتماد دریافت نشد (راهکاران در دسترس نیست، Timeout،
 * پاسخ ناقص/نامعتبر، کالا با SKU در راهکاران پیدا نشد و …).
 *
 * سیاست: «Fail closed» — عملیات متوقف می‌شود، چون فروش کالایی که موجودی‌اش
 * نامعلوم است همان مشکلی است که این قابلیت برای جلوگیری از آن ساخته شده.
 */
export class StockVerificationUnavailableError extends Error {
  constructor(
    readonly reason:
      | 'disabled_misconfigured'
      | 'missing_sku'
      | 'product_not_found'
      | 'empty_stock_info'
      | 'invalid_stock_info'
      | 'rahkaran_error'
      | 'timeout'
      | 'variant_not_found',
    readonly variantId?: number,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'StockVerificationUnavailableError';
  }
}

// ============================================================
// Pure helpers (exported for tests)
// ============================================================

export interface StockConfig {
  enabled: boolean;
  requestTimeoutMs: number;
  deadlineMs: number;
  pendingInvoiceWindowHours: number;
  softReservationMinutes: number;
  concurrency: number;
  productIdCacheMs: number;
}

export function readStockConfig(
  get: (key: string) => string | undefined,
): StockConfig {
  const num = (key: string, fallback: number, min = 0) => {
    const raw = get(key);
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return fallback;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value >= min ? value : fallback;
  };

  return {
    enabled:
      String(get('RAHKARAN_STOCK_CHECK_ENABLED') ?? 'true')
        .trim()
        .toLowerCase() !== 'false',
    requestTimeoutMs: num('RAHKARAN_STOCK_CHECK_REQUEST_TIMEOUT_MS', 5000, 500),
    deadlineMs: num('RAHKARAN_STOCK_CHECK_DEADLINE_MS', 12000, 1000),
    pendingInvoiceWindowHours: num(
      'RAHKARAN_STOCK_PENDING_INVOICE_WINDOW_HOURS',
      72,
    ),
    softReservationMinutes: num('RAHKARAN_STOCK_SOFT_RESERVATION_MINUTES', 20),
    concurrency: Math.max(
      1,
      Math.floor(num('RAHKARAN_STOCK_CHECK_CONCURRENCY', 4, 1)),
    ),
    productIdCacheMs: num(
      'RAHKARAN_STOCK_PRODUCT_ID_CACHE_MS',
      6 * 60 * 60 * 1000,
    ),
  };
}

/** همان نرمال‌سازی SKU که Sync روزانه انجام می‌دهد (trim + ارقام فارسی/عربی) */
export function normalizeSku(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  return value
    .trim()
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

/** جمع تعدادِ ردیف‌های تکراری یک واریانت (مثلاً ردیف عادی + ردیف هدیه) */
export function aggregateRequirements(
  lines: StockRequirementLine[],
): Map<number, number> {
  const totals = new Map<number, number>();

  for (const line of lines) {
    const variantId = Number(line.variantId);
    const quantity = Number(line.quantity);

    if (!Number.isInteger(variantId) || variantId <= 0) continue;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    totals.set(variantId, (totals.get(variantId) ?? 0) + quantity);
  }

  return totals;
}

/**
 * اعتبارسنجی و استخراج موجودی از پاسخ GetRemainingQuantityInfo.
 *
 * - پاسخ خالی/غیرآرایه = نامعتبر (همان رفتار محتاطانهٔ Sync تکی محصول که
 *   در این حالت موجودی را تغییر نمی‌دهد).
 * - انبارِ غایب در پاسخ = صفر (همان قاعدهٔ `extractWarehouseStock`).
 * - مقدار غیرعددی برای یکی از دو انبار فروش = نامعتبر.
 */
export function parseRemainingQuantity(
  info: RahkaranRemainingQuantity[] | null | undefined,
): { hadishMall: number; retail: number; total: number } {
  if (!Array.isArray(info) || info.length === 0) {
    throw new StockVerificationUnavailableError('empty_stock_info');
  }

  for (const row of info) {
    const storeId = Number(row?.StoreID);
    if (storeId !== HADISH_MALL_WAREHOUSE_ID && storeId !== RETAIL_WAREHOUSE_ID)
      continue;

    const raw = row.RemainingQuantity;
    if (raw !== null && raw !== undefined && !Number.isFinite(Number(raw))) {
      throw new StockVerificationUnavailableError('invalid_stock_info');
    }
  }

  const { hadishMall, retail, total } = extractBothWarehouseStocks(info);

  return {
    hadishMall: hadishMall.quantity,
    retail: retail.quantity,
    total,
  };
}

/**
 * محاسبهٔ موجودی سایت و موجودی قابل خرید.
 *
 * - `siteStock` = مانده راهکاران − اقلام پرداخت‌شده‌ای که هنوز در راهکاران
 *   فاکتور نشده‌اند. سایت موجودی را هنگام پرداخت کم می‌کند و راهکاران پس از
 *   ثبت فاکتور؛ بدون این تفریق، هر به‌روزرسانی در این فاصله واحدهای فروخته‌شده
 *   را دوباره «موجود» می‌کرد.
 * - `available` = siteStock − رزرو نرم (سفارش‌های در انتظار پرداختِ اخیرِ
 *   دیگران). رزرو نرم عمداً در ستون stock نوشته نمی‌شود، چون هنگام پرداخت آن
 *   سفارش `confirmOrderPayment` خودش کم می‌کند (وگرنه کسر دوباره رخ می‌دهد).
 */
export function computeSellable(input: {
  rahkaranTotal: number;
  paidNotInvoiced: number;
  softReserved: number;
}): { siteStock: number; available: number } {
  const total = Math.floor(Number(input.rahkaranTotal) || 0);
  const siteStock = Math.max(0, total - Math.max(0, input.paidNotInvoiced));
  const available = Math.max(0, siteStock - Math.max(0, input.softReserved));

  return { siteStock, available };
}

const faNumber = (value: number) => Number(value).toLocaleString('fa-IR');

export function describeVariant(
  productTitle: string,
  variantLabel: string | null,
): string {
  return variantLabel ? `${productTitle} – ${variantLabel}` : productTitle;
}

/** پیام فارسی افزودن به سبد */
export function addToCartShortageMessage(input: {
  productTitle: string;
  variantLabel: string | null;
  available: number;
  inCart: number;
}): string {
  const name = `«${describeVariant(input.productTitle, input.variantLabel)}»`;

  if (input.available <= 0) {
    return input.inCart > 0
      ? `${name} دیگر موجود نیست؛ لطفاً آن را از سبد خرید حذف کنید.`
      : `${name} در حال حاضر موجود نیست.`;
  }

  if (input.inCart > 0) {
    return (
      `امکان افزودن تعداد بیشتری از ${name} وجود ندارد. ` +
      `موجودی قابل خرید ${faNumber(input.available)} عدد است و ` +
      `${faNumber(input.inCart)} عدد آن در سبد خرید شماست.`
    );
  }

  return (
    `موجودی ${name} کافی نیست. ` +
    `در حال حاضر فقط ${faNumber(input.available)} عدد از این کالا قابل خرید است.`
  );
}

/** پیام فارسی مرحلهٔ نهایی خرید (همهٔ اقلام ناکافی با تعداد موجود) */
export function checkoutShortageMessage(
  shortages: StockShortage[],
  stage: StockCheckStage,
): string {
  const lines = shortages.map(item => {
    const name = `«${describeVariant(item.productTitle, item.variantLabel)}»`;
    return item.available > 0
      ? `${name}: درخواستی ${faNumber(item.requested)} عدد، موجود ${faNumber(item.available)} عدد`
      : `${name}: ناموجود`;
  });

  const head =
    stage === 'payment_start' || stage === 'wallet_confirm'
      ? 'موجودی برخی کالاهای این سفارش تغییر کرده و امکان پرداخت آن نیست. لطفاً سبد خرید را اصلاح کرده و سفارش را دوباره ثبت کنید:'
      : 'موجودی برخی کالاهای سبد خرید کافی نیست. لطفاً سبد خود را اصلاح کنید:';

  return `${head} ${lines.join('؛ ')}`;
}

export function unavailableMessage(stage: StockCheckStage): string {
  const base = 'در حال حاضر امکان بررسی موجودی از انبار وجود ندارد.';

  switch (stage) {
    case 'add_to_cart':
    case 'update_cart':
      return `${base} کالا به سبد خرید اضافه نشد؛ لطفاً چند لحظه دیگر دوباره تلاش کنید.`;
    case 'checkout':
      return `${base} سفارش ثبت نشد و مبلغی کسر نشده است؛ لطفاً چند لحظه دیگر دوباره تلاش کنید.`;
    default:
      return `${base} انتقال به پرداخت انجام نشد و مبلغی کسر نشده است؛ لطفاً چند لحظه دیگر دوباره تلاش کنید.`;
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await handler(items[index]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

// ============================================================
// Service
// ============================================================

interface VariantWithDetails {
  variant: Variant;
  productTitle: string;
  variantLabel: string | null;
}

interface PendingDeductions {
  paidNotInvoiced: number;
  softReserved: number;
}

@Injectable()
export class RahkaranStockService {
  private readonly logger = new Logger(RahkaranStockService.name);

  private readonly config: StockConfig;

  /** SKU → شناسهٔ کالای راهکاران (نگاشت پایدار است؛ موجودی هرگز کش نمی‌شود) */
  private readonly productIdCache = new Map<
    string,
    { productId: number; expiresAt: number }
  >();

  constructor(
    @Inject(forwardRef(() => RahkaranService))
    private readonly rahkaranService: RahkaranService,

    @InjectRepository(Variant)
    private readonly variantRepo: Repository<Variant>,

    private readonly dataSource: DataSource,

    @Optional()
    private readonly configService?: ConfigService,

    @Optional()
    private readonly botEventsService?: BotEventsService,
  ) {
    this.config = readStockConfig(
      key => this.configService?.get<string>(key) ?? process.env[key],
    );

    if (!this.config.enabled) {
      this.logger.warn(
        structuredLog('stock.check.disabled', {
          note: 'RAHKARAN_STOCK_CHECK_ENABLED=false; only local site stock is checked',
        }),
      );
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ----------------------------------------------------------
  // High-level guards (throw HTTP exceptions with Persian messages)
  // ----------------------------------------------------------

  /**
   * مرحلهٔ ۱: افزودن به سبد / افزایش تعداد.
   *
   * @param requestedTotal مجموع «تعداد فعلی همین واریانت در سبد + تعداد جدید»
   */
  async assertCanAddToCart(input: {
    variantId: number;
    requestedTotal: number;
    inCart: number;
    stage?: Extract<StockCheckStage, 'add_to_cart' | 'update_cart'>;
    userId?: number;
  }): Promise<VariantStockResult | null> {
    const stage = input.stage ?? 'add_to_cart';
    const verification = await this.verifyOrThrowUnavailable(
      [{ variantId: input.variantId, quantity: input.requestedTotal }],
      { stage, excludeUserId: input.userId },
    );

    const shortage = verification.shortages[0];
    if (shortage) {
      throw new ConflictException({
        statusCode: 409,
        code: STOCK_ERROR_CODES.INSUFFICIENT,
        message: addToCartShortageMessage({
          productTitle: shortage.productTitle,
          variantLabel: shortage.variantLabel,
          available: shortage.available,
          inCart: input.inCart,
        }),
        items: [{ ...shortage, inCart: input.inCart }],
      });
    }

    return verification.results[0] ?? null;
  }

  /**
   * مرحلهٔ ۲: نهایی‌کردن خرید / پیش از انتقال به درگاه.
   * همهٔ اقلام با هم بررسی می‌شوند و همهٔ اقلام ناکافی یکجا گزارش می‌شوند.
   */
  async assertCheckoutStock(
    lines: StockRequirementLine[],
    options: StockCheckOptions,
  ): Promise<StockVerificationResult> {
    const verification = await this.verifyOrThrowUnavailable(lines, options);

    if (verification.shortages.length) {
      throw new ConflictException({
        statusCode: 409,
        code: STOCK_ERROR_CODES.INSUFFICIENT,
        message: checkoutShortageMessage(verification.shortages, options.stage),
        items: verification.shortages,
      });
    }

    return verification;
  }

  private async verifyOrThrowUnavailable(
    lines: StockRequirementLine[],
    options: StockCheckOptions,
  ): Promise<StockVerificationResult> {
    try {
      return await this.verifyAndSync(lines, options);
    } catch (error) {
      if (error instanceof HttpException) throw error;

      throw new ServiceUnavailableException({
        statusCode: 503,
        code: STOCK_ERROR_CODES.UNAVAILABLE,
        message: unavailableMessage(options.stage),
      });
    }
  }

  // ----------------------------------------------------------
  // Core
  // ----------------------------------------------------------

  /**
   * موجودی لحظه‌ای را از راهکاران می‌گیرد، موجودی سایت را به‌روز می‌کند و
   * کفایت را برای هر واریانت گزارش می‌دهد.
   *
   * @throws StockVerificationUnavailableError اگر موجودی قابل‌اعتماد دریافت نشود
   */
  async verifyAndSync(
    lines: StockRequirementLine[],
    options: StockCheckOptions,
  ): Promise<StockVerificationResult> {
    const correlationId =
      options.correlationId ?? createCorrelationId('stock-check');
    const requirements = aggregateRequirements(lines);

    if (!requirements.size) {
      return {
        ok: true,
        shortages: [],
        results: [],
        verifiedWithRahkaran: false,
      };
    }

    const variantIds = [...requirements.keys()].sort((a, b) => a - b);
    const details = await this.loadVariants(variantIds);

    if (!this.config.enabled) {
      return this.verifyLocally(requirements, details, options);
    }

    const startedAt = Date.now();
    const ctx: RahkaranLogContext = {
      correlationId,
      orderId: options.orderId,
      stage: `stock_${options.stage}`,
    };

    try {
      // ── 1) راهکاران (خارج از هر تراکنش/قفل دیتابیس) ─────────────────
      const live = await this.withDeadline(
        runWithConcurrency(variantIds, this.config.concurrency, variantId =>
          this.fetchLiveStock(details.get(variantId)!.variant, ctx),
        ),
        this.config.deadlineMs,
      );
      const liveById = new Map(variantIds.map((id, i) => [id, live[i]]));

      // ── 2) به‌روزرسانی اتمیک موجودی سایت ─────────────────────────────
      const results = await this.applyAndEvaluate(
        requirements,
        liveById,
        options,
      );

      const shortages: StockShortage[] = results
        .filter(result => !result.sufficient)
        .map(result => {
          const detail = details.get(result.variantId)!;
          return {
            variantId: result.variantId,
            productId: detail.variant.productId ?? null,
            productTitle: detail.productTitle,
            variantLabel: detail.variantLabel,
            requested: result.requested,
            available: result.available,
          };
        });

      this.logger.log(
        structuredLog('stock.check.completed', {
          correlationId,
          stage: options.stage,
          orderId: options.orderId,
          durationMs: Date.now() - startedAt,
          items: results.map(result => ({
            variantId: result.variantId,
            sku: result.sku,
            rahkaranProductId: result.rahkaranProductId,
            requested: result.requested,
            hadishMall: result.hadishMall,
            retail: result.retail,
            paidNotInvoiced: result.paidNotInvoiced,
            softReserved: result.softReserved,
            available: result.available,
          })),
          shortages: shortages.length,
        }),
      );

      return {
        ok: shortages.length === 0,
        shortages,
        results,
        verifiedWithRahkaran: true,
      };
    } catch (error) {
      // فقط شناسه‌ها/تعدادها لاگ می‌شوند؛ نه موبایل/نام کاربر/Cookie/توکن.
      this.logger.error(
        structuredLog('stock.check.unavailable', {
          correlationId,
          stage: options.stage,
          orderId: options.orderId,
          durationMs: Date.now() - startedAt,
          variantIds,
          reason:
            error instanceof StockVerificationUnavailableError
              ? error.reason
              : 'rahkaran_error',
          variantId:
            error instanceof StockVerificationUnavailableError
              ? error.variantId
              : undefined,
          error: serializeError(error),
        }),
      );

      if (error instanceof StockVerificationUnavailableError) throw error;

      throw new StockVerificationUnavailableError(
        'rahkaran_error',
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ----------------------------------------------------------
  // Rahkaran
  // ----------------------------------------------------------

  private async fetchLiveStock(
    variant: Variant,
    ctx: RahkaranLogContext,
  ): Promise<{
    sku: string;
    rahkaranProductId: number;
    hadishMall: number;
    retail: number;
    total: number;
  }> {
    const sku = normalizeSku(variant.sku);

    if (!sku) {
      throw new StockVerificationUnavailableError('missing_sku', variant.id);
    }

    const rahkaranProductId = await this.resolveRahkaranProductId(
      sku,
      variant.id,
      ctx,
    );

    let info: RahkaranRemainingQuantity[];
    try {
      info = await this.rahkaranService.getRemainingQuantityInfo(
        rahkaranProductId,
        ctx,
        { timeoutMs: this.config.requestTimeoutMs },
      );
    } catch (error) {
      throw new StockVerificationUnavailableError(
        'rahkaran_error',
        variant.id,
        error instanceof Error ? error.message : String(error),
      );
    }

    try {
      const stock = parseRemainingQuantity(info);
      return { sku, rahkaranProductId, ...stock };
    } catch (error) {
      if (error instanceof StockVerificationUnavailableError) {
        throw new StockVerificationUnavailableError(error.reason, variant.id);
      }
      throw error;
    }
  }

  private async resolveRahkaranProductId(
    sku: string,
    variantId: number,
    ctx: RahkaranLogContext,
  ): Promise<number> {
    const cached = this.productIdCache.get(sku);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.productId;
    }

    let response: any;
    try {
      response = await this.rahkaranService.getRetailProductByBarcode(
        sku,
        1,
        10,
        ctx,
        { timeoutMs: this.config.requestTimeoutMs },
      );
    } catch (error) {
      throw new StockVerificationUnavailableError(
        'rahkaran_error',
        variantId,
        error instanceof Error ? error.message : String(error),
      );
    }

    // همان شکل پاسخی که ثبت فاکتور استفاده می‌کند
    const product = response?.product ?? response;
    const productId = Number(product?.productId);

    if (!Number.isInteger(productId) || productId <= 0) {
      throw new StockVerificationUnavailableError(
        'product_not_found',
        variantId,
      );
    }

    if (this.config.productIdCacheMs > 0) {
      this.productIdCache.set(sku, {
        productId,
        expiresAt: Date.now() + this.config.productIdCacheMs,
      });
    }

    return productId;
  }

  private withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StockVerificationUnavailableError('timeout')),
        ms,
      );
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // ----------------------------------------------------------
  // Database
  // ----------------------------------------------------------

  private async loadVariants(
    variantIds: number[],
  ): Promise<Map<number, VariantWithDetails>> {
    const variants = await this.variantRepo.find({
      where: { id: In(variantIds) },
      relations: { product: true, color: true, size: true },
    });

    const map = new Map<number, VariantWithDetails>();
    for (const variant of variants) {
      const parts = [variant.color?.name, variant.size?.name]
        .map(part => String(part ?? '').trim())
        .filter(Boolean);

      map.set(variant.id, {
        variant,
        productTitle: variant.product?.title || 'محصول',
        variantLabel: parts.length ? parts.join(' / ') : null,
      });
    }

    for (const id of variantIds) {
      if (!map.has(id)) {
        throw new StockVerificationUnavailableError('variant_not_found', id);
      }
    }

    return map;
  }

  /**
   * در یک تراکنش کوتاه:
   *   ۱. ردیف واریانت‌ها به ترتیب id قفل می‌شوند (FOR UPDATE)،
   *   ۲. اقلام «پرداخت‌شده و فاکتورنشده» و «رزرو نرم» خوانده می‌شوند،
   *   ۳. موجودی سایت (stock و موجودی هر انبار) نوشته می‌شود.
   *
   * `confirmOrderPayment` هم کسر موجودی را روی همین ردیف‌ها و به ترتیب id
   * انجام می‌دهد؛ پس یا پرداخت قبل از ما commit شده (و در «پرداخت‌شده و
   * فاکتورنشده» دیده می‌شود) یا بعد از ما و کسرش را روی عدد ما اعمال می‌کند.
   * در هر دو حالت کسر تکراری یا گم‌شدن کسر رخ نمی‌دهد.
   */
  private async applyAndEvaluate(
    requirements: Map<number, number>,
    liveById: Map<
      number,
      {
        sku: string;
        rahkaranProductId: number;
        hadishMall: number;
        retail: number;
        total: number;
      }
    >,
    options: StockCheckOptions,
  ): Promise<VariantStockResult[]> {
    const variantIds = [...requirements.keys()].sort((a, b) => a - b);
    const stockChanges: VariantStockChangeInput[] = [];

    const results = await this.dataSource.transaction(async manager => {
      const locked = await manager
        .getRepository(Variant)
        .createQueryBuilder('variant')
        .setLock('pessimistic_write')
        .where('variant.id IN (:...ids)', { ids: variantIds })
        .orderBy('variant.id', 'ASC')
        .getMany();
      const lockedById = new Map(locked.map(variant => [variant.id, variant]));

      const pending = await this.loadPendingDeductions(
        manager,
        variantIds,
        options.excludeUserId,
      );

      const output: VariantStockResult[] = [];

      for (const variantId of variantIds) {
        const live = liveById.get(variantId)!;
        const current = lockedById.get(variantId);
        const deductions = pending.get(variantId) ?? {
          paidNotInvoiced: 0,
          softReserved: 0,
        };
        const requested = requirements.get(variantId)!;

        const { siteStock, available } = computeSellable({
          rahkaranTotal: live.total,
          paidNotInvoiced: deductions.paidNotInvoiced,
          softReserved: deductions.softReserved,
        });

        if (current) {
          const oldStock = Number(current.stock) || 0;
          const changed =
            oldStock !== siteStock ||
            Number(current.stockRetail) !== live.retail ||
            Number(current.stockHadishMall) !== live.hadishMall;

          if (changed) {
            await manager.update(
              Variant,
              { id: variantId },
              {
                stock: siteStock,
                stockRetail: live.retail,
                stockHadishMall: live.hadishMall,
              },
            );
          }

          if (oldStock !== siteStock) {
            stockChanges.push({
              variantId,
              productTitle: `محصول ${current.productId}`,
              variantLabel: null,
              sku: current.sku ?? null,
              oldStock,
              newStock: siteStock,
              syncedAt: new Date(),
            });
          }
        }

        output.push({
          variantId,
          sku: live.sku,
          rahkaranProductId: live.rahkaranProductId,
          hadishMall: live.hadishMall,
          retail: live.retail,
          rahkaranTotal: live.total,
          paidNotInvoiced: deductions.paidNotInvoiced,
          softReserved: deductions.softReserved,
          siteStock,
          available,
          requested,
          sufficient: available >= requested,
        });
      }

      return output;
    });

    await this.reportStockTransitions(stockChanges);

    return results;
  }

  /**
   * اقلامی که در مانده راهکاران هنوز دیده نمی‌شوند ولی از نظر سایت فروخته یا
   * رزرو شده‌اند.
   */
  protected async loadPendingDeductions(
    manager: EntityManager,
    variantIds: number[],
    excludeUserId?: number,
  ): Promise<Map<number, PendingDeductions>> {
    const result = new Map<number, PendingDeductions>();
    const ensure = (variantId: number) => {
      let entry = result.get(variantId);
      if (!entry) {
        entry = { paidNotInvoiced: 0, softReserved: 0 };
        result.set(variantId, entry);
      }
      return entry;
    };

    if (!variantIds.length) return result;

    // ۱) پرداخت‌شده (کسر از سایت انجام شده) ولی فاکتور راهکاران هنوز موفق نشده
    if (this.config.pendingInvoiceWindowHours > 0) {
      const since = new Date(
        Date.now() - this.config.pendingInvoiceWindowHours * 60 * 60 * 1000,
      );

      const rows: Array<{ variantId: number | string; qty: number | string }> =
        await manager
          .createQueryBuilder(OrderItem, 'item')
          .innerJoin('item.order', 'o')
          .leftJoin(RahkaranInvoiceSync, 'sync', 'sync.orderId = o.id')
          .select('item.variantId', 'variantId')
          .addSelect('COALESCE(SUM(item.quantity), 0)', 'qty')
          .where('item.variantId IN (:...variantIds)', { variantIds })
          .andWhere('o.status IN (:...paidStatuses)', {
            paidStatuses: [
              OrderStatus.PAID,
              OrderStatus.SHIPPED,
              OrderStatus.DELIVERED,
            ],
          })
          .andWhere('o.updatedAt >= :since', { since })
          .andWhere('(sync.id IS NULL OR sync.status <> :success)', {
            success: RahkaranInvoiceSyncStatus.SUCCESS,
          })
          .groupBy('item.variantId')
          .getRawMany();

      for (const row of rows) {
        ensure(Number(row.variantId)).paidNotInvoiced += Number(row.qty) || 0;
      }
    }

    // ۲) رزرو نرم: سفارش‌های در انتظار پرداختِ اخیرِ سایر مشتریان
    if (this.config.softReservationMinutes > 0) {
      const softSince = new Date(
        Date.now() - this.config.softReservationMinutes * 60 * 1000,
      );

      const query = manager
        .createQueryBuilder(OrderItem, 'item')
        .innerJoin('item.order', 'o')
        .innerJoin('o.user', 'u')
        .select('item.variantId', 'variantId')
        .addSelect('COALESCE(SUM(item.quantity), 0)', 'qty')
        .where('item.variantId IN (:...variantIds)', { variantIds })
        .andWhere('o.status = :pending', { pending: OrderStatus.PENDING })
        .andWhere('o.createdAt >= :softSince', { softSince });

      if (excludeUserId) {
        query.andWhere('u.id <> :excludeUserId', { excludeUserId });
      }

      const rows: Array<{ variantId: number | string; qty: number | string }> =
        await query.groupBy('item.variantId').getRawMany();

      for (const row of rows) {
        ensure(Number(row.variantId)).softReserved += Number(row.qty) || 0;
      }
    }

    return result;
  }

  private async reportStockTransitions(
    changes: VariantStockChangeInput[],
  ): Promise<void> {
    if (!changes.length || !this.botEventsService) return;

    try {
      const hydrated = await this.variantRepo.find({
        where: { id: In(changes.map(change => change.variantId)) },
        relations: { product: true, color: true, size: true },
      });
      const byId = new Map(hydrated.map(variant => [variant.id, variant]));

      await this.botEventsService.evaluateVariantStockTransitions(
        changes.map(change => {
          const full = byId.get(change.variantId);
          const parts = [full?.color?.name, full?.size?.name]
            .map(part => String(part ?? '').trim())
            .filter(Boolean);
          return {
            ...change,
            productTitle: full?.product?.title ?? change.productTitle,
            variantLabel: parts.length ? parts.join(' / ') : null,
          };
        }),
      );
    } catch (error) {
      // گزارش ربات هرگز نباید سبد/پرداخت را خراب کند
      this.logger.warn(
        structuredLog('stock.check.report_failed', {
          error: serializeError(error),
        }),
      );
    }
  }

  // ----------------------------------------------------------
  // Disabled mode
  // ----------------------------------------------------------

  /** فقط وقتی RAHKARAN_STOCK_CHECK_ENABLED=false — همان بررسی محلی قبلی */
  private verifyLocally(
    requirements: Map<number, number>,
    details: Map<number, VariantWithDetails>,
    options: StockCheckOptions,
  ): StockVerificationResult {
    const results: VariantStockResult[] = [];
    const shortages: StockShortage[] = [];

    for (const [variantId, requested] of requirements) {
      const detail = details.get(variantId)!;
      const available = Math.max(0, Number(detail.variant.stock) || 0);
      const sufficient = available >= requested;

      results.push({
        variantId,
        sku: normalizeSku(detail.variant.sku),
        rahkaranProductId: 0,
        hadishMall: Number(detail.variant.stockHadishMall) || 0,
        retail: Number(detail.variant.stockRetail) || 0,
        rahkaranTotal: available,
        paidNotInvoiced: 0,
        softReserved: 0,
        siteStock: available,
        available,
        requested,
        sufficient,
      });

      if (!sufficient) {
        shortages.push({
          variantId,
          productId: detail.variant.productId ?? null,
          productTitle: detail.productTitle,
          variantLabel: detail.variantLabel,
          requested,
          available,
        });
      }
    }

    this.logger.debug(
      structuredLog('stock.check.local_only', {
        stage: options.stage,
        variantIds: [...requirements.keys()],
      }),
    );

    return {
      ok: shortages.length === 0,
      shortages,
      results,
      verifiedWithRahkaran: false,
    };
  }
}
