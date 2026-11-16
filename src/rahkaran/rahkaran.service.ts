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
  id: number;
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

  async createLoyaltyMemberForUser(id: number) {
    const user = await this.usersService.findOne(id);

    if (!user) {
      throw new BadRequestException('کاربر پیدا نشد');
    }

    const fullName = user.fullName?.trim() || 't';

    const parts = fullName.split(/\s+/);

    const firstName = parts.shift() || '';
    const lastName = parts.join(' ');

    await this.ensureAuthenticated();

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
    );

    if (!this.isSuccessful(response)) {
      throw new BadRequestException(
        this.getRahkaranError(response) || 'ثبت کاربر در راهکاران ناموفق بود',
      );
    }

    this.logger.log(`✅ ثبت کاربر موفق بود `);

    const customerId = await this.getCustomerIdByMobile(user.phone);

    const loyalityResponse = await this.request(
      `${this.baseUrl}/Retail/LoyaltyApi/RetailLoyaltyMemberService.svc/loyaltyMember`,
      {
        method: 'POST',
        data: {
          loyaltyMemberPatternId: 3,
          customerId,
        },
        headers: this.authHeaders(),
      },
    );

    if (!this.isSuccessful(loyalityResponse)) {
      throw new BadRequestException(
        this.getRahkaranError(loyalityResponse) ||
          'ثبت کاربر در مشتریان وفادار ناموفق بود',
      );
    }

    this.logger.log(`✅ ثبت کاربر در مشتریان وفادار موفق بود `);
  }

  async getCustomerIdByMobile(
    mobile: string,
    ctx?: RahkaranLogContext,
  ): Promise<number> {
    const phone = mobile?.trim();

    if (!phone) {
      throw new BadRequestException(
        'شماره موبایل مشتری برای جستجو در راهکاران مشخص نیست.',
      );
    }

    const url =
      `${this.baseUrl}/Services/Retail/ESales.svc/customers?` +
      new URLSearchParams({ mobile: phone }).toString();

    let response = await this.authenticatedRequest<
      RahkaranResponse<RahkaranCustomer[] | null>
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
      response = await this.request<
        RahkaranResponse<RahkaranCustomer[] | null>
      >(url, { method: 'GET', headers: this.authHeaders() }, ctx);
    }

    if (response?.metadata?.isSuccessfull !== true) {
      throw new BadRequestException(
        response?.metadata?.errorMessage ||
          'جستجوی مشتری در راهکاران ناموفق بود.',
      );
    }

    // Do not use an unrelated result (or the website's user ID) for an invoice.
    if (response.result != null && !Array.isArray(response.result)) {
      throw new BadRequestException('پاسخ جستجوی مشتری راهکاران معتبر نیست.');
    }

    if (!response?.result?.length) {
      throw new BadRequestException(
        `شناسه معتبر و یکتای مشتری با موبایل ${phone} در راهکاران پیدا نشد.`,
      );
    }

    return response?.result[0]?.id;
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

    const settlementPolicyId = 18;

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
        loyaltyProgramID: null,
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
