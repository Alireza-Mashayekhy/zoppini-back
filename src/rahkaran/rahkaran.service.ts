// src/rahkaran/rahkaran.service.ts

import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosRequestConfig } from 'axios';
import { constants, createPublicKey, publicEncrypt } from 'crypto';
import { firstValueFrom } from 'rxjs';
import {
  createCorrelationId,
  maskMobile,
  sanitizeForLog,
  serializeError,
  stringifySafe,
  structuredLog,
  truncateForLog,
} from 'src/common/logging/structured-logger';
import { UsersService } from 'src/users/users.service';

/**
 * زمینهٔ ردیابی یک فرآیند راهکاران؛ در تمام گام‌های یک درخواست
 * (lookup، ساخت payload، ارسال، retry) حفظ می‌شود تا با یک
 * `correlationId` بتوان کل مسیر را در لاگ‌ها پیدا کرد.
 */
export interface RahkaranLogContext {
  correlationId?: string;
  orderId?: number;
  orderNumber?: string;
  /** شمارهٔ تلاش (۱ برای تلاش اول) */
  attempt?: number;
  /** مرحلهٔ جاری فرآیند ثبت فاکتور */
  stage?: string;
}

/**
 * نتیجهٔ «نامعلوم» یک درخواست تغییردهنده (POST) به راهکاران.
 *
 * معنی: درخواست ارسال شده است، ولی پاسخی که برگشته قابل اعتماد نیست
 * (Timeout، قطع اتصال، پاسخ خالی/بدشکل). در این حالت ممکن است راهکاران
 * عملیات را انجام داده باشد؛ پس ارسال دوباره بدون بررسی، ریسک ثبت تکراری
 * (فاکتور/مشتری/عضو وفاداری) دارد.
 *
 * این خطا هرگز به کاربر نهایی نمایش داده نمی‌شود؛ لایهٔ بالادست آن را به
 * وضعیت «نیازمند تطبیق» تبدیل می‌کند.
 */
export class RahkaranUnknownOutcomeError extends Error {
  readonly unknownOutcome = true;

  constructor(message: string) {
    super(message);

    this.name = 'RahkaranUnknownOutcomeError';
  }
}

/** آیا این خطا یعنی «نتیجهٔ عملیات در راهکاران نامعلوم است»؟ */
export function isRahkaranUnknownOutcome(error: unknown): boolean {
  return (
    (error as { unknownOutcome?: boolean } | null)?.unknownOutcome === true
  );
}

interface RahkaranSession {
  id: string;
  rsa: {
    M: string;
    E: string;
  };
}

interface CashRegisterInfo {
  cashierId: number;
  userId: number;
  cashRegisterId: number;
  cashierTitle: string;
  cashRegisterTitle: string;
  retailSessionId: number;
  sessionNumber: string;
  retailInteriorSectionId: number | null;
  retailInteriorSectionTitle: string;
  retailInteriorSectionType: number;
  hasSupervisor: boolean;
  retailShopID: number;
  kioskIP: string | null;
}

interface RahkaranLoginState {
  sessionId: string;
  cookie: string;
  cashRegister: CashRegisterInfo;
  authenticatedAt: Date;
  lastTickAt: Date | null;
}

export interface RahkaranRetailProduct {
  productId: number;
  productNumber: string;
  productName: string;
  unitRef: number;
  RetailUnitRef: number;
  unitName: string;
  retailUnitName: string;
  fee: number;
  partId: number;
  hasToppings: boolean;
}

interface RahkaranResponse<T> {
  result: T;
  metadata: {
    isSuccessfull: boolean;
    errorMessage: string | null;
  };
}

/**
 * انبار خرده‌فروشی (انبار قبلی سایت)
 *
 * RAHKARAN_STOCK_STORE_ID نام قدیمی این تنظیم است
 * و هنوز به عنوان fallback پشتیبانی می‌شود.
 */
export const RETAIL_WAREHOUSE_ID = Number(
  process.env.RAHKARAN_RETAIL_STORE_ID ||
    process.env.RAHKARAN_STOCK_STORE_ID ||
    20,
);

/**
 * انبار هدیش مال (انبار جدید)
 */
export const HADISH_MALL_WAREHOUSE_ID = Number(
  process.env.RAHKARAN_HADISH_MALL_STORE_ID || 23,
);

export interface RahkaranWarehouseStock {
  storeId: number;
  storeName: string | null;
  quantity: number;
}

/**
 * موجودی یک محصول را به تفکیک انبار استخراج می‌کند.
 *
 * اگر انباری در پاسخ راهکاران نباشد، موجودی آن صفر در نظر گرفته می‌شود.
 */
export function extractWarehouseStock(
  stocks: RahkaranRemainingQuantity[] | null | undefined,
  storeId: number,
): RahkaranWarehouseStock {
  const store = (stocks ?? []).find(
    item => Number(item.StoreID) === Number(storeId),
  );

  const quantity = Number(store?.RemainingQuantity ?? 0);

  return {
    storeId: Number(storeId),
    storeName: store?.StoreName ?? null,
    quantity: Number.isFinite(quantity) ? quantity : 0,
  };
}

/**
 * موجودی هر دو انبار را برمی‌گرداند.
 */
export function extractBothWarehouseStocks(
  stocks: RahkaranRemainingQuantity[] | null | undefined,
): {
  hadishMall: RahkaranWarehouseStock;
  retail: RahkaranWarehouseStock;
  total: number;
} {
  const hadishMall = extractWarehouseStock(stocks, HADISH_MALL_WAREHOUSE_ID);
  const retail = extractWarehouseStock(stocks, RETAIL_WAREHOUSE_ID);

  return {
    hadishMall,
    retail,
    total: hadishMall.quantity + retail.quantity,
  };
}

interface RahkaranCustomer {
  Id: number;
  mobile: string;
}

interface RahkaranRemainingQuantity {
  StoreID: number;
  StoreName: string;
  RemainingQuantity: number | null;
  RetailReserveQuantity: number | null;
  InventoryReserveQuantity: number | null;
  InventoryPhysicalQuantity: number | null;
  AllowNegativeSales: boolean;
  MaxNegativeSales: number | null;
  AllowNegativeReserves: boolean;
  MaxNegativeReserves: number | null;
}

const RAHKARAN_SHIPPING_PRODUCT_ID = 83467;

export interface CreateRahkaranInvoiceItem {
  productId: number;
  unitId: number;
  quantity: number;
  fee: number;
  price: number;

  /**
   * انباری که این آیتم از آن ثبت می‌شود.
   *
   * اگر ارسال نشود از انبار پیش‌فرض (خرده‌فروشی) استفاده می‌شود.
   */
  inventoryId?: number;
}

export interface CreateRahkaranInvoiceInput {
  customerId: number;
  items: CreateRahkaranInvoiceItem[];

  /**
   * در صورت نیاز بعداً از تنظیمات/DB قابل تغییر است.
   */
  inventoryId?: number;
  settlementPolicyId?: number;
  documentPatternId?: number;
  salesAgentId?: number | null;

  /**
   * مبلغ دریافتی.
   */
  receiptAmount: number;

  description?: string;
}

export interface RahkaranInvoiceResponse {
  id?: number;
  invoiceId?: number;
  number?: string;
  document?: any;
  [key: string]: any;
}

@Injectable()
export class RahkaranService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RahkaranService.name);

  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly machineName: string;

  private readonly autoLogin: boolean;
  private readonly tickIntervalMs: number;

  private state: RahkaranLoginState | null = null;

  private tickTimer: NodeJS.Timeout | null = null;

  /**
   * جلوگیری از اینکه همزمان چند login به راهکاران انجام شود.
   */
  private loginPromise: Promise<void> | null = null;

  /**
   * جلوگیری از اجرای موازی ثبت مشتری/عضو وفاداری برای یک userId واحد
   * (جلوگیری از ساخت مشتری یا Loyalty Membership تکراری در درخواست‌های هم‌زمان).
   */
  private readonly loyaltySyncInFlight = new Map<
    number,
    Promise<{ customerId: number | null; skipped?: 'already_synced' }>
  >();

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    this.baseUrl =
      this.configService.get<string>('RAHKARAN_BASE_URL')?.replace(/\/$/, '') ||
      '';

    this.username = this.configService.get<string>('RAHKARAN_USERNAME') || '';

    this.password = this.configService.get<string>('RAHKARAN_PASSWORD') || '';

    this.machineName =
      this.configService.get<string>('RAHKARAN_MACHINE_NAME') || '';

    this.autoLogin =
      this.configService.get<string>('RAHKARAN_AUTO_LOGIN') !== 'false';

    this.tickIntervalMs = Number(
      this.configService.get<string>('RAHKARAN_TICK_INTERVAL_MS') || 300000,
    );

    if (!this.baseUrl) {
      this.logger.warn('RAHKARAN_BASE_URL تنظیم نشده است.');
    }
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  async onModuleInit(): Promise<void> {
    if (!this.autoLogin) {
      this.logger.log('Rahkaran auto login غیرفعال است.');

      return;
    }

    if (!this.username || !this.password || !this.machineName) {
      this.logger.warn('اطلاعات Rahkaran کامل نیست. Auto login انجام نشد.');

      return;
    }

    try {
      await this.login();

      this.startTickTimer();

      this.logger.log('✅ اتصال به راهکاران با موفقیت برقرار شد.');
    } catch (error) {
      this.logger.error(
        '❌ اتصال اولیه به راهکاران ناموفق بود.',
        this.getErrorMessage(error),
      );

      /**
       * عمداً اینجا throw نمی‌کنیم.
       *
       * چون نمی‌خواهیم به خاطر down بودن راهکاران،
       * کل NestJS application بالا نیاید.
       */
    }
  }

  onModuleDestroy(): void {
    this.stopTickTimer();
  }

  // ============================================================
  // Public Authentication API
  // ============================================================

  /**
   * ورود کامل:
   *
   * 1. دریافت session
   * 2. login به Rahkaran
   * 3. ورود به صندوق Retail
   */
  async login(): Promise<void> {
    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = this.performLogin();

    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  /**
   * احراز هویت کامل را از ابتدا انجام می‌دهد.
   */
  private async performLogin(): Promise<void> {
    this.clearState();

    this.logger.log(
      structuredLog('rahkaran.auth.session_request', { baseUrl: this.baseUrl }),
    );

    const session = await this.getSession();

    // توجه: SessionId و کلید RSA حامل اطلاعات احراز هویت هستند و هرگز
    // به‌صورت کامل لاگ نمی‌شوند.
    this.logger.log(
      structuredLog('rahkaran.auth.session_received', {
        sessionIdSuffix: session.id ? session.id.slice(-6) : null,
      }),
    );

    const encryptedPassword = this.encryptPassword(
      session.id,
      this.password,
      session.rsa,
    );

    const loginResponse = await this.request<any>(
      `${this.baseUrl}/Services/Framework/AuthenticationService.svc/login`,
      {
        method: 'POST',
        data: {
          sessionId: session.id,
          username: this.username,
          password: encryptedPassword,
        },
      },
    );

    // بدنهٔ پاسخ login ممکن است حامل اطلاعات Session باشد؛ فقط نتیجه لاگ می‌شود.
    this.logger.debug(
      structuredLog('rahkaran.auth.login_response', {
        successful: this.isSuccessful(loginResponse),
        errorMessage: this.getRahkaranError(loginResponse),
      }),
    );

    // Login موفق راهکاران با HTTP 200 + Cookie مشخص می‌شود.
    // Body این endpoint ممکن است خالی باشد.
    const loginCookie = this.extractCookieFromLastResponse();

    if (!loginCookie) {
      throw new BadRequestException(
        this.getRahkaranError(loginResponse) ||
          'Login راهکاران موفق نبود؛ Cookie احراز هویت دریافت نشد.',
      );
    }

    this.logger.log('✅ Login راهکاران موفق بود.');
    /**
     * بعد از login، وارد صندوق Retail می‌شویم.
     */
    const cashierResponse = await this.request<any>(
      `${this.baseUrl}/Retail/Api/CashRegisterManagement/RetailDesktopAuthenticationService.svc/DesktopCashierLogin`,
      {
        method: 'POST',
        data: this.machineName,
        headers: this.authHeaders(),
      },
    );

    if (!this.isSuccessful(cashierResponse)) {
      throw new BadRequestException(
        this.getRahkaranError(cashierResponse) ||
          'ورود به صندوق Retail ناموفق بود.',
      );
    }

    const cashRegister = cashierResponse?.result?.cashRegister;

    if (!cashRegister) {
      throw new BadRequestException('اطلاعات صندوق از راهکاران دریافت نشد.');
    }

    const cookie =
      this.extractCookie(cashierResponse) ||
      this.extractCookieFromLastResponse();

    this.state = {
      sessionId: session.id,
      cookie,
      cashRegister,
      authenticatedAt: new Date(),
      lastTickAt: null,
    };

    this.logger.log(
      `✅ ورود به صندوق موفق بود. ` +
        `Shop: ${cashRegister.retailShopID}, ` +
        `CashRegister: ${cashRegister.cashRegisterId}, ` +
        `RetailSession: ${cashRegister.retailSessionId}`,
    );
  }

  // ============================================================
  // Session
  // ============================================================

  /**
   * طبق مستند:
   *
   * GET
   * /Services/Framework/AuthenticationService.svc/session
   */
  private async getSession(): Promise<RahkaranSession> {
    const response = await this.request<RahkaranSession>(
      `${this.baseUrl}/Services/Framework/AuthenticationService.svc/session`,
      {
        method: 'GET',
      },
    );

    if (!response?.id || !response?.rsa?.M || !response?.rsa?.E) {
      throw new BadRequestException('پاسخ Session راهکاران معتبر نیست.');
    }

    return response;
  }

  // ============================================================
  // Tick
  // ============================================================

  /**
   * تمدید Session سمت راهکاران.
   */
  async tick(): Promise<boolean> {
    if (!this.state) {
      this.logger.warn('⚠️ Tick انجام نشد؛ Session فعالی وجود ندارد.');

      return false;
    }

    try {
      const response = await this.request<any>(
        `${this.baseUrl}/Retail/Api/CashRegisterManagement/RetailMobileAuthenticationService.svc/Tick`,
        {
          method: 'GET',
          headers: this.authHeaders(),
        },
      );

      const success = response?.result === true;

      if (success) {
        this.state.lastTickAt = new Date();

        this.logger.debug('🔄 Rahkaran Session با Tick تمدید شد.');

        return true;
      }

      this.logger.warn(
        `⚠️ Tick موفق نبود: ${
          this.getRahkaranError(response) || 'Unknown error'
        }`,
      );

      // Session را نامعتبر فرض کن
      this.clearState();

      try {
        await this.login();

        this.logger.log('🔄 Login مجدد بعد از Tick ناموفق با موفقیت انجام شد.');

        return true;
      } catch (loginError) {
        this.logger.error(
          '❌ Login مجدد بعد از Tick ناموفق بود.',
          this.getErrorMessage(loginError),
        );

        return false;
      }
    } catch (error) {
      this.logger.error(
        '❌ Tick راهکاران با خطا مواجه شد.',
        this.getErrorMessage(error),
      );

      this.clearState();

      /**
       * در صورت خراب شدن Session،
       * login مجدد انجام می‌دهیم.
       */
      try {
        await this.login();

        return true;
      } catch (loginError) {
        this.logger.error(
          '❌ Login مجدد بعد از Tick ناموفق بود.',
          this.getErrorMessage(loginError),
        );

        return false;
      }
    }
  }

  // ============================================================
  // Tick Timer
  // ============================================================

  private startTickTimer(): void {
    this.stopTickTimer();

    if (!this.tickIntervalMs || this.tickIntervalMs <= 0) {
      return;
    }

    this.tickTimer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);

    this.logger.log(
      `⏱️ Rahkaran Tick فعال شد. Interval: ${this.tickIntervalMs}ms`,
    );
  }

  private stopTickTimer(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // ============================================================
  // Authentication State
  // ============================================================

  /**
   * هر سرویس Rahkaran در مراحل بعدی باید قبل از request
   * این متد را صدا بزند.
   */
  async ensureAuthenticated(): Promise<void> {
    if (!this.state) {
      await this.login();
    }
  }

  isAuthenticated(): boolean {
    return !!this.state;
  }

  getAuthState() {
    if (!this.state) {
      return null;
    }

    return {
      authenticated: true,
      sessionId: this.state.sessionId,
      retailSessionId: this.state.cashRegister.retailSessionId,
      retailShopId: this.state.cashRegister.retailShopID,
      cashRegisterId: this.state.cashRegister.cashRegisterId,
      cashierId: this.state.cashRegister.cashierId,
      authenticatedAt: this.state.authenticatedAt,
      lastTickAt: this.state.lastTickAt,
    };
  }

  getRetailShopId(): number {
    this.requireState();

    return this.state!.cashRegister.retailShopID;
  }

  getRetailSessionId(): number {
    this.requireState();

    return this.state!.cashRegister.retailSessionId;
  }

  getCashRegisterId(): number {
    this.requireState();

    return this.state!.cashRegister.cashRegisterId;
  }

  // ============================================================
  // HTTP
  // ============================================================

  /**
   * در مراحل بعد تمام APIهای Rahkaran
   * از همین متد استفاده خواهند کرد.
   */
  private async request<T>(
    url: string,
    config: AxiosRequestConfig = {},
    ctx?: RahkaranLogContext,
  ): Promise<T> {
    const method = String(config.method || 'GET').toUpperCase();

    // فقط مسیر endpoint لاگ می‌شود؛ QueryString ممکن است دادهٔ جستجو
    // (موبایل/بارکد) داشته باشد.
    const endpointPath = this.toEndpointPath(url);

    const startedAt = Date.now();

    try {
      const response = await firstValueFrom(
        this.httpService.request<T>({
          ...config,
          url,
          validateStatus: () => true,
          headers: {
            ...(config.headers || {}),
          },
        }),
      );

      const durationMs = Date.now() - startedAt;

      this.captureCookies(response.headers);

      if (response.status < 200 || response.status >= 300) {
        /*
         * 401/403 یعنی Session مرده است. قبلاً فقط مسیرهای GET (در
         * authenticatedRequest) State را پاک می‌کردند و یک POST با 401
         * Session مرده را نگه می‌داشت تا همهٔ درخواست‌های بعدی هم 401 شوند.
         */
        if (response.status === 401 || response.status === 403) {
          this.clearState();
        }

        this.logger.warn(
          structuredLog('rahkaran.http.non_2xx', {
            correlationId: ctx?.correlationId,
            orderId: ctx?.orderId,
            stage: ctx?.stage,
            method,
            endpoint: endpointPath,
            httpStatus: response.status,
            durationMs,
            responseBody: truncateForLog(stringifySafe(response.data), 500),
          }),
        );

        throw new BadRequestException(
          `Rahkaran HTTP ${response.status}: ${JSON.stringify(response.data)}`,
        );
      }

      this.logger.debug(
        structuredLog('rahkaran.http.response', {
          correlationId: ctx?.correlationId,
          orderId: ctx?.orderId,
          stage: ctx?.stage,
          method,
          endpoint: endpointPath,
          httpStatus: response.status,
          durationMs,
        }),
      );

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;

      const status = axiosError.response?.status;

      const durationMs = Date.now() - startedAt;

      // خطای BadRequestException خودِ ما (رلهی non-2xx) دوباره با جزئیات
      // کامل اینجا لاگ نمی‌شود؛ لاگ بالا کافی است.
      if (!(error instanceof BadRequestException)) {
        this.logger.error(
          structuredLog('rahkaran.http.error', {
            correlationId: ctx?.correlationId,
            orderId: ctx?.orderId,
            stage: ctx?.stage,
            method,
            endpoint: endpointPath,
            httpStatus: status,
            durationMs,
            error: serializeError(error),
          }),
        );
      }

      if (status === 401 || status === 403) {
        this.clearState();

        throw new BadRequestException(
          'Session راهکاران معتبر نیست یا منقضی شده است.',
        );
      }

      /**
       * خطای HTTP صریح (۴xx/۵xx) که خودمان بالا به BadRequestException تبدیل
       * کردیم «صریحاً رد شده / پردازش نشده» است و نباید «نامعلوم» تلقی شود.
       * (این بررسی باید بعد از 401/403 بیاید تا پاک‌سازی Session از دست نرود.)
       */
      if (error instanceof BadRequestException) {
        throw error;
      }

      /*
       * درخواست تغییردهنده (POST/PUT/PATCH/DELETE) که هیچ پاسخ HTTP
       * نگرفته است (Timeout، ECONNRESET، قطع شبکه): نمی‌دانیم راهکاران
       * عملیات را انجام داده یا نه. این را «نتیجهٔ نامعلوم» علامت می‌زنیم تا
       * لایهٔ بالادست کورکورانه retry نکند.
       */
      const isMutatingMethod = !['GET', 'HEAD', 'OPTIONS'].includes(method);

      if (isMutatingMethod && !axiosError?.response) {
        this.logger.error(
          structuredLog('rahkaran.http.outcome_unknown', {
            correlationId: ctx?.correlationId,
            orderId: ctx?.orderId,
            stage: ctx?.stage,
            method,
            endpoint: endpointPath,
            durationMs,
            note: 'request_sent_without_valid_response',
            error: serializeError(error),
          }),
        );

        throw new RahkaranUnknownOutcomeError(
          `ارتباط با راهکاران در حین ${method} ${endpointPath} قطع شد؛ ` +
            'نتیجهٔ عملیات نامعلوم است.',
        );
      }

      throw error;
    }
  }

  /**
   * استخراج مسیر endpoint بدون QueryString برای لاگ‌گذاری امن.
   */
  private toEndpointPath(url: string): string {
    try {
      const parsed = new URL(url, this.baseUrl || undefined);

      return parsed.pathname;
    } catch {
      return url.split('?')[0];
    }
  }

  private authHeaders(): Record<string, string> {
    const cookie = this.state?.cookie || this.latestCookies.join('; ');

    if (!cookie) {
      return {};
    }

    return {
      Cookie: cookie,
    };
  }

  // ============================================================
  // RSA Password Encryption
  // ============================================================

  private encryptPassword(
    sessionId: string,
    password: string,
    rsa: {
      M: string;
      E: string;
    },
  ): string {
    const publicKey = this.createRsaPublicKey(rsa.M, rsa.E);

    const plainText = `${sessionId}**${password}`;

    // ⚠️ plainText شامل رمز عبور است و هرگز لاگ نمی‌شود.
    const encrypted = publicEncrypt(
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(plainText, 'utf8'),
    );

    return encrypted.toString('hex');
  }

  private createRsaPublicKey(modulusHex: string, exponentHex: string): string {
    const modulusBase64Url = Buffer.from(modulusHex, 'hex')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    const exponentBase64Url = Buffer.from(exponentHex, 'hex')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    const key = createPublicKey({
      key: {
        kty: 'RSA',
        n: modulusBase64Url,
        e: exponentBase64Url,
      },
      format: 'jwk',
    });

    return key.export({
      type: 'spki',
      format: 'pem',
    }) as string;
  }

  // ============================================================
  // Cookie
  // ============================================================

  private latestCookies: string[] = [];

  private captureCookies(headers: any): void {
    const setCookie = headers?.['set-cookie'];

    if (!setCookie) {
      return;
    }

    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];

    const incomingCookies = cookies.map(
      (cookie: string) => cookie.split(';')[0],
    );

    const cookieMap = new Map<string, string>();

    // Cookieهای قبلی
    for (const cookie of this.latestCookies) {
      const [name] = cookie.split('=');

      if (name) {
        cookieMap.set(name, cookie);
      }
    }

    // Cookieهای جدید
    for (const cookie of incomingCookies) {
      const [name] = cookie.split('=');

      if (name) {
        cookieMap.set(name, cookie);
      }
    }

    this.latestCookies = Array.from(cookieMap.values());

    if (this.state && this.latestCookies.length > 0) {
      this.state.cookie = this.latestCookies.join('; ');
    }
  }

  private extractCookie(response: any): string {
    /**
     * اگر خود response کوکی را expose کرده باشد.
     */
    if (response?.headers?.['set-cookie']) {
      const cookies = response.headers['set-cookie'];

      return (Array.isArray(cookies) ? cookies : [cookies])
        .map((cookie: string) => cookie.split(';')[0])
        .join('; ');
    }

    return '';
  }

  private extractCookieFromLastResponse(): string {
    return this.latestCookies.join('; ');
  }

  // ============================================================
  // Helpers
  // ============================================================

  private clearState(): void {
    this.state = null;
    this.latestCookies = [];
  }

  private requireState(): void {
    if (!this.state) {
      throw new BadRequestException('اتصال به راهکاران برقرار نیست.');
    }
  }

  private isSuccessful(response: any): boolean {
    return (
      response?.metadata?.isSuccessfull === true ||
      response?.metadata?.isSuccessful === true ||
      response?.result?.isSuccessfull === true ||
      response?.result?.isSuccessful === true ||
      response?.result === true
    );
  }

  /**
   * آیا پاسخ، «پاکت» استاندارد راهکاران (`metadata`/`result`) را دارد؟
   *
   * نبودِ پاکت روی یک درخواست تغییردهنده یعنی پاسخ قابل تفسیر نیست
   * (مثلاً بدنهٔ خالی یا HTML خطای پروکسی) و نتیجه «نامعلوم» است.
   */
  private hasRahkaranEnvelope(response: any): boolean {
    return (
      !!response &&
      typeof response === 'object' &&
      ('metadata' in response || 'result' in response)
    );
  }

  private getRahkaranError(response: any): string | null {
    return (
      response?.metadata?.errorMessage ||
      response?.result?.errorMessage ||
      response?.errorMessage ||
      null
    );
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  // ============================================================
  // Retail Products
  // ============================================================

  async getRetailProducts(
    input = '',
    page = 1,
    count = 20,
  ): Promise<RahkaranRetailProduct[]> {
    await this.ensureAuthenticated();

    const params = new URLSearchParams({
      input,
      page: String(page),
      count: String(count),
    });

    const url = `${this.baseUrl}/Retail/Api/Structure/ProductService.svc/GetProducts?${params.toString()}`;

    // authenticatedRequest در صورت خطای 401/403 خودش login مجدد و retry می‌کند
    let response = await this.authenticatedRequest<
      RahkaranResponse<RahkaranRetailProduct[]>
    >(url, {
      method: 'GET',
    });

    // اگر Session منقضی شده باشد ولی HTTP 200 برگشته باشد
    if (this.isSessionExpiredResponse(response)) {
      this.logger.warn(
        `⚠️ Session هنگام جستجوی محصولات راهکاران (input=${input}) منقضی شده بود. Login مجدد...`,
      );

      this.clearState();

      await this.login();

      response = await this.request<RahkaranResponse<RahkaranRetailProduct[]>>(
        url,
        {
          method: 'GET',
          headers: this.authHeaders(),
        },
      );
    }

    if (response?.metadata?.isSuccessfull !== true) {
      throw new BadRequestException(
        response?.metadata?.errorMessage ||
          'دریافت محصولات راهکاران ناموفق بود.',
      );
    }

    return response.result ?? [];
  }

  async getRetailProductByBarcode(
    barcode: string,
    page = 1,
    count = 10,
    ctx?: RahkaranLogContext,
  ): Promise<any> {
    const params = new URLSearchParams({
      barcode,
      page: String(page),
      count: String(count),
    });

    const url =
      `${this.baseUrl}/Retail/Api/Structure/ProductService.svc/` +
      `getProductByBarcode?${params.toString()}`;

    let response = await this.authenticatedRequest<any>(
      url,
      {
        method: 'GET',
      },
      ctx,
    );

    // اگر Session منقضی شده باشد ولی HTTP 200 برگشته باشد
    if (this.isSessionExpiredResponse(response)) {
      this.logger.warn(
        structuredLog('rahkaran.auth.session_expired_mid_request', {
          correlationId: ctx?.correlationId,
          orderId: ctx?.orderId,
          stage: ctx?.stage,
          operation: 'getProductByBarcode',
        }),
      );

      this.clearState();

      await this.login();

      response = await this.request<any>(
        url,
        {
          method: 'GET',
          headers: this.authHeaders(),
        },
        ctx,
      );
    }

    if (response?.metadata?.isSuccessfull !== true) {
      throw new BadRequestException(
        response?.metadata?.errorMessage || 'دریافت محصول راهکاران ناموفق بود.',
      );
    }

    return response.result;
  }

  async getRetailProduct(productId: number): Promise<RahkaranRetailProduct> {
    await this.ensureAuthenticated();

    const url =
      `${this.baseUrl}/Retail/Api/Structure/ProductService.svc/` +
      `GetProduct?id=${productId}`;

    // authenticatedRequest در صورت خطای 401/403 خودش login مجدد و retry می‌کند
    let response = await this.authenticatedRequest<
      RahkaranResponse<RahkaranRetailProduct>
    >(url, {
      method: 'GET',
    });

    // اگر Session منقضی شده باشد ولی HTTP 200 برگشته باشد
    if (this.isSessionExpiredResponse(response)) {
      this.logger.warn(
        `⚠️ Session هنگام دریافت محصول ${productId} منقضی شده بود. Login مجدد...`,
      );

      this.clearState();

      await this.login();

      response = await this.request<RahkaranResponse<RahkaranRetailProduct>>(
        url,
        {
          method: 'GET',
          headers: this.authHeaders(),
        },
      );
    }

    if (response?.metadata?.isSuccessfull !== true) {
      throw new BadRequestException(
        response?.metadata?.errorMessage || 'دریافت محصول راهکاران ناموفق بود.',
      );
    }

    return response.result;
  }

  async getRemainingQuantityInfo(
    productId: number,
    ctx?: RahkaranLogContext,
  ): Promise<RahkaranRemainingQuantity[]> {
    await this.ensureAuthenticated();

    const url =
      `${this.baseUrl}/Retail/Api/DocumentStructure/StoreService.svc/` +
      `GetRemainingQuantityInfo?productId=${productId}`;

    let response = await this.authenticatedRequest<{
      result: RahkaranRemainingQuantity[];
      metadata?: {
        isSuccessfull?: boolean;
        isSuccessful?: boolean;
        errorMessage?: string | null;
      };
    }>(
      url,
      {
        method: 'GET',
      },
      ctx,
    );

    // ==========================================================
    // Session Expired
    // ==========================================================

    if (this.isSessionExpiredResponse(response)) {
      this.logger.warn(
        structuredLog('rahkaran.auth.session_expired_mid_request', {
          correlationId: ctx?.correlationId,
          orderId: ctx?.orderId,
          stage: ctx?.stage,
          operation: 'GetRemainingQuantityInfo',
          productId,
        }),
      );

      this.clearState();

      await this.login();

      // Retry فقط همان درخواست
      response = await this.request(
        url,
        {
          method: 'GET',
          headers: this.authHeaders(),
        },
        ctx,
      );
    }

    // ==========================================================
    // بررسی Response
    // ==========================================================

    if (
      response?.metadata?.isSuccessfull === false ||
      response?.metadata?.isSuccessful === false
    ) {
      throw new BadRequestException(
        response?.metadata?.errorMessage ||
          `دریافت موجودی محصول ${productId} از راهکاران ناموفق بود.`,
      );
    }

    return response?.result ?? [];
  }

  async getRemainingQuantityForStore(
    productId: number,
    storeId = RETAIL_WAREHOUSE_ID,
  ): Promise<number | null> {
    const result = await this.getRemainingQuantityInfo(productId);

    const store = result.find(item => Number(item.StoreID) === Number(storeId));

    if (!store) {
      return null;
    }

    const quantity = Number(store.RemainingQuantity);

    return Number.isFinite(quantity) ? quantity : null;
  }

  /**
   * ثبت کاربر در راهکاران: «مشتری» و سپس «عضو باشگاه وفاداری».
   *
   * این متد آگاهانه idempotent است، چون از چند مسیر صدا زده می‌شود
   * (ثبت‌نام، نظرسنجی گیمیفیکیشن، retry دستی) و تکرارش نباید مشتری/عضو
   * تکراری در راهکاران بسازد:
   *
   *   • اگر عضویت وفاداری قبلاً موفق شده باشد (`loyaltyMemberSyncedAt`)،
   *     هیچ درخواستی ارسال نمی‌شود.
   *   • اگر شناسهٔ مشتری روی کاربر ذخیره شده باشد (`rahkaranId`)، مشتری
   *     دوباره ساخته نمی‌شود.
   *   • اگر مشتری با همین موبایل در راهکاران باشد، همان استفاده می‌شود.
   *   • ترتیب عملیات: ابتدا مشتری، بعد عضویت وفاداری (عضویت به
   *     `customerId` نیاز دارد) — همان ترتیبی که قبلاً بود.
   *
   * اگر عملیات نیمه‌تمام بماند (مشتری ثبت شد، عضویت نشد) فراخوانی بعدی
   * فقط بخش باقی‌مانده را انجام می‌دهد.
   */
  async createLoyaltyMemberForUser(
    id: number,
    externalCorrelationId?: string,
  ): Promise<{
    customerId: number | null;
    skipped?: 'already_synced';
  }> {
    const inFlight = this.loyaltySyncInFlight.get(id);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.performCreateLoyaltyMemberForUser(
      id,
      externalCorrelationId,
    );
    this.loyaltySyncInFlight.set(id, promise);

    try {
      return await promise;
    } finally {
      this.loyaltySyncInFlight.delete(id);
    }
  }

  private async performCreateLoyaltyMemberForUser(
    id: number,
    externalCorrelationId?: string,
  ): Promise<{
    customerId: number | null;
    skipped?: 'already_synced';
  }> {
    const correlationId =
      externalCorrelationId || createCorrelationId('rah-loyalty');

    const logCtx: RahkaranLogContext = {
      correlationId,
      stage: 'start',
    };

    const user = await this.usersService.findOne(id);

    if (!user) {
      throw new BadRequestException('کاربر پیدا نشد');
    }

    if (user.loyaltyMemberSyncedAt) {
      this.logger.log(
        structuredLog('rahkaran.loyalty.skipped', {
          correlationId,
          userId: user.id,
          stage: logCtx.stage,
          reason: 'already_synced',
          customerId: user.rahkaranId ?? null,
        }),
      );

      return {
        customerId: user.rahkaranId ?? null,
        skipped: 'already_synced',
      };
    }

    await this.ensureAuthenticated();

    logCtx.stage = 'resolve_customer';

    let customerId: number | null = user.rahkaranId
      ? Number(user.rahkaranId)
      : null;

    if (customerId != null) {
      this.logger.log(
        structuredLog('rahkaran.customer.reused_from_db', {
          correlationId,
          userId: user.id,
          stage: logCtx.stage,
          customerId,
        }),
      );
    } else {
      customerId = await this.findCustomerIdByMobile(user.phone, logCtx);

      if (customerId != null) {
        this.logger.log(
          structuredLog('rahkaran.customer.reused_from_rahkaran', {
            correlationId,
            userId: user.id,
            stage: logCtx.stage,
            customerId,
            customerMobile: maskMobile(user.phone),
          }),
        );
      } else {
        logCtx.stage = 'create_customer';

        const fullName = user.fullName?.trim() || 't';

        const parts = fullName.split(/\s+/);

        const firstName = parts.shift() || '';
        const lastName = parts.join(' ');

        this.logger.log(
          structuredLog('rahkaran.customer.create.start', {
            correlationId,
            userId: user.id,
            stage: logCtx.stage,
            customerMobile: maskMobile(user.phone),
          }),
        );

        const response = await this.request(
          `${this.baseUrl}/Retail/Api/Structure/CustomerService.svc/customer`,
          {
            method: 'POST',
            data: {
              partyType: 0,
              Id: 0,
              firstName: firstName,
              lastName: lastName,
              nationalID: user?.nationalCode,
              mobile: user?.phone,
              tel: null,
            },
            headers: this.authHeaders(),
          },
          logCtx,
        );

        /*
         * پاسخ بی‌ساختار روی یک POST یعنی ممکن است مشتری ساخته شده باشد؛
         * دوباره فرستادن می‌تواند مشتری تکراری بسازد.
         */
        if (!this.hasRahkaranEnvelope(response)) {
          this.logger.error(
            structuredLog('rahkaran.customer.create.outcome_unknown', {
              correlationId,
              userId: user.id,
              stage: logCtx.stage,
              customerMobile: maskMobile(user.phone),
              note: 'customer_may_exist_in_rahkaran — قبل از تلاش دوباره بررسی کنید.',
              responseBody: truncateForLog(stringifySafe(response), 300),
            }),
          );

          throw new RahkaranUnknownOutcomeError(
            'پاسخ ثبت مشتری در راهکاران قابل تفسیر نبود؛ نتیجهٔ ثبت نامعلوم است.',
          );
        }

        if (!this.isSuccessful(response)) {
          throw new BadRequestException(
            this.getRahkaranError(response) ||
              'ثبت کاربر در راهکاران ناموفق بود',
          );
        }

        this.logger.log(
          structuredLog('rahkaran.customer.create.success', {
            correlationId,
            userId: user.id,
            stage: logCtx.stage,
          }),
        );

        logCtx.stage = 'resolve_customer';

        customerId = await this.findCustomerIdByMobile(user.phone, logCtx);

        if (customerId == null) {
          throw new BadRequestException(
            'مشتری در راهکاران ثبت شد ولی شناسهٔ آن با این موبایل پیدا نشد؛ ' +
              'نیاز به بررسی دستی دارد.',
          );
        }
      }

      /*
       * ذخیرهٔ شناسهٔ مشتری: کلید جلوگیری از ساخت مشتری تکراری در
       * فراخوانی‌های بعدی. اگر این ذخیره شکست بخورد، بررسی دوباره با
       * موبایل جلوی تکرار را می‌گیرد؛ پس خطا را فقط لاگ می‌کنیم.
       */
      try {
        await this.usersService.update(user.id, { rahkaranId: customerId });

        this.logger.log(
          structuredLog('rahkaran.customer.persisted', {
            correlationId,
            userId: user.id,
            stage: logCtx.stage,
            customerId,
          }),
        );
      } catch (persistError) {
        this.logger.error(
          structuredLog('rahkaran.customer.persist_error', {
            correlationId,
            userId: user.id,
            stage: logCtx.stage,
            customerId,
            error: serializeError(persistError),
          }),
        );
      }
    }

    logCtx.stage = 'create_loyalty_member';

    const loyaltyResponse = await this.request(
      `${this.baseUrl}/Retail/LoyaltyApi/RetailLoyaltyMemberService.svc/loyaltyMember`,
      {
        method: 'POST',
        data: {
          loyaltyMemberPatternId: 3,
          customerId,
        },
        headers: this.authHeaders(),
      },
      logCtx,
    );

    if (!this.hasRahkaranEnvelope(loyaltyResponse)) {
      this.logger.error(
        structuredLog('rahkaran.loyalty.outcome_unknown', {
          correlationId,
          userId: user.id,
          stage: logCtx.stage,
          customerId,
          note: 'loyalty_member_may_exist_in_rahkaran — قبل از تلاش دوباره بررسی کنید.',
          responseBody: truncateForLog(stringifySafe(loyaltyResponse), 300),
        }),
      );

      throw new RahkaranUnknownOutcomeError(
        'پاسخ ثبت عضو باشگاه وفاداری قابل تفسیر نبود؛ نتیجهٔ ثبت نامعلوم است.',
      );
    }

    if (!this.isSuccessful(loyaltyResponse)) {
      throw new BadRequestException(
        this.getRahkaranError(loyaltyResponse) ||
          'ثبت کاربر در مشتریان وفادار ناموفق بود',
      );
    }

    /*
     * ثبت موفق عضویت: تنها همین‌جا علامت می‌خورد. اگر این UPDATE شکست
     * بخورد، عضویت در راهکاران ساخته شده ولی رکورد ما نمی‌داند؛ لاگ
     * بحرانی می‌گیریم تا سفارش بعدی بررسی دستی شود.
     */
    try {
      await this.usersService.update(user.id, {
        loyaltyMemberSyncedAt: new Date(),
      });
    } catch (persistError) {
      this.logger.error(
        structuredLog('rahkaran.loyalty.persist_error', {
          correlationId,
          userId: user.id,
          stage: logCtx.stage,
          customerId,
          note: 'loyalty_member_created_but_marker_not_persisted',
          error: serializeError(persistError),
        }),
      );

      throw persistError;
    }

    this.logger.log(
      structuredLog('rahkaran.loyalty.success', {
        correlationId,
        userId: user.id,
        stage: logCtx.stage,
        customerId,
      }),
    );

    return { customerId };
  }

  /**
   * شناسهٔ مشتری با موبایل؛ برای مسیرهایی که «نبود مشتری» حالت عادی است
   * (مثل ثبت‌نام) `null` برمی‌گرداند و فقط خطاهای واقعی را throw می‌کند.
   */
  private async findCustomerIdByMobile(
    mobile: string | null | undefined,
    ctx?: RahkaranLogContext,
  ): Promise<number | null> {
    const phone = mobile?.trim();

    if (!phone) {
      throw new BadRequestException(
        'شماره موبایل مشتری برای جستجو در راهکاران مشخص نیست.',
      );
    }

    const url =
      `${this.baseUrl}/Retail/Api/Structure/CustomerService.svc/customer?` +
      new URLSearchParams({ input: phone, searchMode: '2' }).toString();

    let response = await this.authenticatedRequest<
      RahkaranResponse<RahkaranCustomer[]>
    >(url, { method: 'GET' }, ctx);

    // Some Rahkaran endpoints report an expired session with HTTP 200.
    if (this.isSessionExpiredResponse(response)) {
      this.logger.warn(
        structuredLog('rahkaran.auth.session_expired_mid_request', {
          correlationId: ctx?.correlationId,
          orderId: ctx?.orderId,
          stage: ctx?.stage,
          operation: 'customersByMobile',
        }),
      );

      this.clearState();
      await this.login();
      response = await this.request<RahkaranResponse<RahkaranCustomer[]>>(
        url,
        { method: 'GET', headers: this.authHeaders() },
        ctx,
      );
    }

    if (response?.metadata?.isSuccessfull !== true) {
      throw new BadRequestException(
        response?.metadata?.errorMessage ||
          'جستجوی مشتری در راهکاران ناموفق بود.',
      );
    }

    // Do not use an unrelated result (or the website's user ID) for an invoice.
    if (!Array.isArray(response.result)) {
      throw new BadRequestException('پاسخ جستجوی مشتری راهکاران معتبر نیست.');
    }

    if (!response?.result?.length) {
      return null;
    }

    /*
     * چند مشتری با یک موبایل: فعلاً رفتار قبلی (انتخاب اولین نتیجه) حفظ
     * می‌شود تا هیچ سفارشی از کار نیفتد، ولی این وضعیت در لاگ علامت می‌خورد
     * چون می‌تواند یعنی فاکتور به مشتری اشتباه وصل شود و نیاز به بررسی
     * دستی/تصمیم کسب‌وکار دارد.
     */
    if (response.result.length > 1) {
      this.logger.warn(
        structuredLog('rahkaran.customer.multiple_matches', {
          correlationId: ctx?.correlationId,
          orderId: ctx?.orderId,
          stage: ctx?.stage,
          matches: response.result.length,
          customerMobile: maskMobile(phone),
          note: 'first_match_used',
        }),
      );
    }

    const id = Number(response.result[0]?.Id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new BadRequestException(
        'شناسهٔ مشتری در پاسخ راهکاران معتبر نیست.',
      );
    }

    return id;
  }

  /**
   * شناسهٔ مشتری راهکاران برای یک موبایل؛ اگر پیدا نشود خطا می‌دهد.
   *
   * مسیر ثبت فاکتور از این متد استفاده می‌کند چون بدون شناسهٔ مشتری،
   * فاکتور نباید ثبت شود.
   */
  async getCustomerIdByMobile(
    mobile: string,
    ctx?: RahkaranLogContext,
  ): Promise<number> {
    const id = await this.findCustomerIdByMobile(mobile, ctx);

    if (id == null) {
      throw new BadRequestException(
        `شناسه معتبر و یکتای مشتری با موبایل ${mobile?.trim()} در راهکاران پیدا نشد.`,
      );
    }

    return id;
  }

  async createSalesInvoice(
    input: CreateRahkaranInvoiceInput,
    ctx?: RahkaranLogContext,
  ): Promise<RahkaranInvoiceResponse> {
    const stage = 'save_invoice';
    const startedAt = Date.now();

    await this.ensureAuthenticated();

    if (!input.customerId) {
      throw new BadRequestException(
        'customerId برای ثبت فاکتور راهکاران مشخص نیست.',
      );
    }

    if (!input.items?.length) {
      throw new BadRequestException(
        'فاکتور راهکاران حداقل باید یک آیتم داشته باشد.',
      );
    }

    const inventoryId = input.inventoryId ?? RETAIL_WAREHOUSE_ID;

    const settlementPolicyId = 25;

    const documentPatternId = 3;

    const items = input.items.map(item => ({
      Id: 0,

      /**
       * هر آیتم می‌تواند از انبار متفاوتی ثبت شود.
       *
       * مثلاً بخشی از انبار هدیش مال و
       * باقی از انبار خرده‌فروشی.
       */
      inventoryId: item.inventoryId ?? inventoryId,

      settlementPolicyId,

      productId: item.productId,

      quantity: Number(item.quantity),

      unitId: item.unitId,

      policies: [],

      toppings: [],

      returnInvoicePermitItemId: null,

      trackingFactor1: null,
      trackingFactor2: null,
      trackingFactor3: null,
      trackingFactor4: null,
      trackingFactor5: null,

      partTrackingFactorRef1: null,
      partTrackingFactorRef2: null,
      partTrackingFactorRef3: null,
      partTrackingFactorRef4: null,
      partTrackingFactorRef5: null,

      isTrackingFactorInputModeManual1: null,
      isTrackingFactorInputModeManual2: null,
      isTrackingFactorInputModeManual3: null,
      isTrackingFactorInputModeManual4: null,
      isTrackingFactorInputModeManual5: null,

      trackingFactorHasQuantity1: false,
      trackingFactorHasQuantity2: false,
      TrackingFactorHasQuantity3: false,
      TrackingFactorHasQuantity4: false,
      TrackingFactorHasQuantity5: false,

      referenceId: null,
    }));

    const document = {
      inventoryId,

      salesAreaId: 5,

      documentPatternId,

      customerId: input.customerId,

      status: 1,

      currencyId: 1,

      items,

      policies: [],

      settlementPolicyId,

      id: 0,

      data: {
        discountCards: [],
        loyaltyProgramID: 1,
      },
    };

    const payload = {
      document,

      receipts: [
        {
          key: 'Cash',
          amount: Number(input.receiptAmount),
          attr: {
            DESCRIPTION: input.description || 'ثبت فاکتور فروش از سایت',
          },
        },
      ],

      payments: [],
    };

    const totalQuantity = input.items.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0,
    );

    this.logger.log(
      structuredLog('rahkaran.invoice.create.start', {
        correlationId: ctx?.correlationId,
        orderId: ctx?.orderId,
        orderNumber: ctx?.orderNumber,
        attempt: ctx?.attempt,
        stage,
        customerId: input.customerId,
        warehouseId: document.inventoryId,
        itemsCount: items.length,
        totalQuantity,
        receiptAmount: Number(input.receiptAmount),
      }),
    );

    // Payload کامل فقط در سطح DEBUG و پس از حذف داده‌های حساس لاگ می‌شود.
    this.logger.debug(
      structuredLog('rahkaran.invoice.create.payload', {
        correlationId: ctx?.correlationId,
        orderId: ctx?.orderId,
        attempt: ctx?.attempt,
        stage,
        payload: sanitizeForLog(payload),
      }),
    );

    const response = await this.request<any>(
      `${this.baseUrl}/Retail/Api/RetailDocuments/InvoiceService.svc/SaveInvoice`,
      {
        method: 'POST',

        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },

        data: payload,
      },
      ctx,
    );

    /*
     * پاسخ بدون «پاکت» راهکاران روی SaveInvoice: نمی‌دانیم فاکتور ثبت شده
     * یا نه (بدنهٔ خالی، HTML خطای پروکسی، ۲xx بدون metadata). ارسال دوباره
     * می‌تواند فاکتور تکراری بسازد؛ پس نتیجه را «نامعلوم» اعلام می‌کنیم.
     */
    if (!this.hasRahkaranEnvelope(response)) {
      this.logger.error(
        structuredLog('rahkaran.invoice.create.outcome_unknown', {
          correlationId: ctx?.correlationId,
          orderId: ctx?.orderId,
          orderNumber: ctx?.orderNumber,
          attempt: ctx?.attempt,
          stage,
          customerId: input.customerId,
          itemsCount: items.length,
          receiptAmount: Number(input.receiptAmount),
          durationMs: Date.now() - startedAt,
          note: 'invoice_may_exist_in_rahkaran — قبل از تلاش دوباره بررسی کنید.',
          responseBody: truncateForLog(stringifySafe(response), 500),
        }),
      );

      throw new RahkaranUnknownOutcomeError(
        'پاسخ ثبت فاکتور در راهکاران قابل تفسیر نبود؛ نتیجهٔ ثبت نامعلوم است.',
      );
    }

    if (!this.isSuccessful(response)) {
      this.logger.error(
        structuredLog('rahkaran.invoice.create.rejected', {
          correlationId: ctx?.correlationId,
          orderId: ctx?.orderId,
          orderNumber: ctx?.orderNumber,
          attempt: ctx?.attempt,
          stage,
          customerId: input.customerId,
          itemsCount: items.length,
          receiptAmount: Number(input.receiptAmount),
          durationMs: Date.now() - startedAt,
          rahkaranError: this.getRahkaranError(response),
          responseBody: truncateForLog(stringifySafe(response), 500),
        }),
      );

      throw new BadRequestException(
        this.getRahkaranError(response) ||
          'ثبت فاکتور فروش در راهکاران ناموفق بود.',
      );
    }

    const result = response?.result ?? response;

    this.logger.log(
      structuredLog('rahkaran.invoice.create.success', {
        correlationId: ctx?.correlationId,
        orderId: ctx?.orderId,
        orderNumber: ctx?.orderNumber,
        attempt: ctx?.attempt,
        stage,
        customerId: input.customerId,
        invoiceId: result?.id ?? result?.invoiceId ?? null,
        invoiceNumber: result?.number ?? null,
        durationMs: Date.now() - startedAt,
      }),
    );

    return result;
  }

  async syncOrderToRahkaran(
    order: {
      id: number;
      orderNumber: string;
      finalPrice: number;
      shippingCost: number;
      user: {
        phone: string;
      };
      items: Array<{
        quantity: number;
        price: number;
        variant: {
          sku: string | null;
        } | null;
      }>;
    },
    ctx?: RahkaranLogContext,
  ) {
    const correlationId = ctx?.correlationId ?? createCorrelationId('rah-inv');

    // ctx محلی که stage در آن به‌روز می‌شود و به همهٔ فراخوان‌های
    // پایین‌دستی منتقل می‌شود.
    const logCtx: RahkaranLogContext = {
      ...ctx,
      correlationId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      stage: 'start',
    };

    const startedAt = Date.now();

    this.logger.log(
      structuredLog('rahkaran.invoice.sync.start', {
        correlationId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        attempt: ctx?.attempt ?? 1,
        itemsCount: order.items?.length ?? 0,
        finalPriceToman: Number(order.finalPrice),
        customerMobile: maskMobile(order.user?.phone),
      }),
    );

    try {
      await this.ensureAuthenticated();

      if (!order.items?.length) {
        throw new BadRequestException(
          `سفارش ${order.id} آیتمی برای ثبت در راهکاران ندارد.`,
        );
      }

      logCtx.stage = 'resolve_customer';

      const customerId = await this.getCustomerIdByMobile(
        order.user?.phone,
        logCtx,
      );

      this.logger.log(
        structuredLog('rahkaran.invoice.customer_resolved', {
          correlationId,
          orderId: order.id,
          attempt: ctx?.attempt,
          stage: logCtx.stage,
          customerId,
          customerMobile: maskMobile(order.user?.phone),
        }),
      );

      logCtx.stage = 'prepare_items';

      const invoiceItems: CreateRahkaranInvoiceItem[] = [];

      for (const item of order.items) {
        const sku = item.variant?.sku?.trim();

        if (!sku) {
          throw new BadRequestException(
            `برای آیتم سفارش ${order.id}، SKU/Barcode وجود ندارد.`,
          );
        }

        // =====================================================
        // دریافت اطلاعات محصول مستقیماً از راهکاران
        // =====================================================

        const productResponse = await this.getRetailProductByBarcode(
          sku,
          1,
          10,
          logCtx,
        );

        const rahkaranProduct = productResponse?.product ?? productResponse;

        if (!rahkaranProduct?.productId) {
          throw new BadRequestException(
            `محصول با بارکد ${sku} در راهکاران پیدا نشد.`,
          );
        }

        if (
          Number(rahkaranProduct.productId) === RAHKARAN_SHIPPING_PRODUCT_ID
        ) {
          throw new BadRequestException(
            'کالای هزینه ارسال نباید در اقلام سبد باشد.',
          );
        }

        const unitId = rahkaranProduct.RetailUnitRef ?? rahkaranProduct.unitRef;

        if (!unitId) {
          throw new BadRequestException(
            `واحد فروش محصول ${rahkaranProduct.productId} در راهکاران مشخص نیست.`,
          );
        }

        const rahkaranFee = Number(rahkaranProduct.fee);

        if (!Number.isFinite(rahkaranFee)) {
          throw new BadRequestException(
            `قیمت محصول ${rahkaranProduct.productId} در راهکاران معتبر نیست.`,
          );
        }

        const quantity = Number(item.quantity);

        // =====================================================
        // موجودی هر دو انبار
        // =====================================================

        const remainingQuantityInfo = await this.getRemainingQuantityInfo(
          rahkaranProduct.productId,
          logCtx,
        );

        const { hadishMall, retail, total } = extractBothWarehouseStocks(
          remainingQuantityInfo,
        );

        // =====================================================
        // بررسی کفایت موجودی (هدیش مال + خرده‌فروشی)
        // =====================================================

        if (total < quantity) {
          throw new BadRequestException(
            `موجودی کافی برای محصول ${rahkaranProduct.productName} ` +
              `(SKU=${sku}) در انبارهای راهکاران وجود ندارد. ` +
              `لازم: ${quantity} | ` +
              `هدیش مال: ${hadishMall.quantity} | ` +
              `خرده‌فروشی: ${retail.quantity}`,
          );
        }

        // =====================================================
        // تقسیم بین انبارها:
        //
        // اول انبار هدیش مال،
        // اگر کافی نبود هرچقدر بود از هدیش مال،
        // باقی از انبار خرده‌فروشی.
        // =====================================================

        const fromHadishMall = Math.min(quantity, hadishMall.quantity);

        const fromRetail = quantity - fromHadishMall;

        if (fromHadishMall > 0) {
          invoiceItems.push({
            productId: Number(rahkaranProduct.productId),
            unitId: Number(unitId),
            quantity: fromHadishMall,
            fee: rahkaranFee,
            price: Number(item.price),
            inventoryId: HADISH_MALL_WAREHOUSE_ID,
          });
        }

        if (fromRetail > 0) {
          invoiceItems.push({
            productId: Number(rahkaranProduct.productId),
            unitId: Number(unitId),
            quantity: fromRetail,
            fee: rahkaranFee,
            price: Number(item.price),
            inventoryId: RETAIL_WAREHOUSE_ID,
          });
        }

        this.logger.log(
          structuredLog('rahkaran.invoice.item_prepared', {
            correlationId,
            orderId: order.id,
            attempt: ctx?.attempt,
            stage: logCtx.stage,
            sku,
            rahkaranProductId: rahkaranProduct.productId,
            quantity,
            fromHadishMall,
            fromRetail,
            hadishMallAvailable: hadishMall.quantity,
            retailAvailable: retail.quantity,
          }),
        );
      }

      // SaveInvoice obtains prices from Rahkaran's price list, not item.price.
      // Use the order's frozen charge (also for older orders/retries), and
      // fail before POST if the configured service product would charge more
      // or less. No stock lookup is needed for this service line.
      const shippingCost = Number(order.shippingCost);
      if (
        order.shippingCost == null ||
        !Number.isFinite(shippingCost) ||
        shippingCost < 0
      ) {
        throw new BadRequestException('هزینه ارسال سفارش معتبر نیست.');
      }
      if (shippingCost > 0) {
        const shippingProduct = await this.getRetailProduct(
          RAHKARAN_SHIPPING_PRODUCT_ID,
        );
        const unitId =
          shippingProduct?.RetailUnitRef ?? shippingProduct?.unitRef;
        if (
          Number(shippingProduct?.productId) !== RAHKARAN_SHIPPING_PRODUCT_ID ||
          !unitId
        ) {
          throw new BadRequestException(
            'کالای هزینه ارسال یا واحد فروش آن در راهکاران معتبر نیست.',
          );
        }
        if (Number(shippingProduct.fee) !== shippingCost * 10) {
          throw new BadRequestException(
            `قیمت کالای هزینه ارسال در راهکاران با هزینه سفارش ${order.id} مطابقت ندارد.`,
          );
        }
        invoiceItems.push({
          productId: RAHKARAN_SHIPPING_PRODUCT_ID,
          unitId: Number(unitId),
          quantity: 1,
          fee: Number(shippingProduct.fee),
          price: shippingCost,
        });
      }

      logCtx.stage = 'save_invoice';

      // =====================================================
      // ثبت فاکتور
      // =====================================================

      const invoice = await this.createSalesInvoice(
        {
          customerId,

          items: invoiceItems,

          receiptAmount: Number(order.finalPrice) * 10,

          description: `Order ${order.orderNumber}`,
        },
        logCtx,
      );

      this.logger.log(
        structuredLog('rahkaran.invoice.sync.completed', {
          correlationId,
          orderId: order.id,
          orderNumber: order.orderNumber,
          attempt: ctx?.attempt,
          invoiceId: invoice?.id ?? invoice?.invoiceId ?? null,
          invoiceNumber: invoice?.number ?? null,
          itemsCount: invoiceItems.length,
          durationMs: Date.now() - startedAt,
        }),
      );

      return invoice;
    } catch (error) {
      // خطای نهایی فرآیند؛ در کنار لاگ‌های جزئی‌تر هر مرحله ثبت می‌شود تا
      // مرحله‌ای که درخواست در آن شکست خورده دقیقاً مشخص باشد.
      this.logger.error(
        structuredLog('rahkaran.invoice.sync.failed', {
          correlationId,
          orderId: order.id,
          orderNumber: order.orderNumber,
          attempt: ctx?.attempt,
          stage: logCtx.stage,
          itemsCount: order.items?.length ?? 0,
          finalPriceToman: Number(order.finalPrice),
          durationMs: Date.now() - startedAt,
          error: serializeError(error),
        }),
      );

      throw error;
    }
  }

  private isSessionExpiredResponse(response: any): boolean {
    const errorMessage = this.getRahkaranError(response);

    if (!errorMessage) {
      return false;
    }

    const message = errorMessage.toLowerCase();

    return (
      message.includes('دوباره وارد سیستم شوید') ||
      message.includes('برای مدتی بدون استفاده') ||
      message.includes('session') ||
      message.includes('جلسه') ||
      message.includes('منقضی') ||
      message.includes('احراز هویت')
    );
  }

  private async authenticatedRequest<T>(
    url: string,
    config: AxiosRequestConfig = {},
    ctx?: RahkaranLogContext,
  ): Promise<T> {
    await this.ensureAuthenticated();

    try {
      return await this.request<T>(
        url,
        {
          ...config,
          headers: {
            ...(config.headers || {}),
            ...this.authHeaders(),
          },
        },
        ctx,
      );
    } catch (error) {
      const message = this.getErrorMessage(error);

      const isAuthError =
        message.includes('Session راهکاران معتبر نیست') ||
        message.includes('401') ||
        message.includes('403') ||
        message.includes('دوباره وارد سیستم شوید') ||
        message.includes('برای مدتی بدون استفاده');

      if (!isAuthError) {
        throw error;
      }

      this.logger.warn(
        structuredLog('rahkaran.auth.session_invalid_retry', {
          correlationId: ctx?.correlationId,
          orderId: ctx?.orderId,
          stage: ctx?.stage,
          endpoint: this.toEndpointPath(url),
          reason: truncateForLog(message, 200),
        }),
      );

      this.clearState();

      await this.login();

      this.logger.log(
        structuredLog('rahkaran.auth.relogin_success', {
          correlationId: ctx?.correlationId,
          orderId: ctx?.orderId,
          stage: ctx?.stage,
          endpoint: this.toEndpointPath(url),
        }),
      );

      return await this.request<T>(
        url,
        {
          ...config,
          headers: {
            ...(config.headers || {}),
            ...this.authHeaders(),
          },
        },
        ctx,
      );
    }
  }
}
