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
import { UsersService } from 'src/users/users.service';

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

    this.logger.log('🔐 دریافت Session از راهکاران...');

    const session = await this.getSession();

    this.logger.log(session);

    this.logger.log(`✅ Session دریافت شد: ${session.id}`);

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

    this.logger.log(`Login response: ${JSON.stringify(loginResponse)}`);

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
  ): Promise<T> {
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

      this.captureCookies(response.headers);

      if (response.status < 200 || response.status >= 300) {
        throw new BadRequestException(
          `Rahkaran HTTP ${response.status}: ${JSON.stringify(response.data)}`,
        );
      }

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;

      const status = axiosError.response?.status;

      this.logger.error(
        `❌ Rahkaran HTTP Error ${status || ''}: ${url}`,
        this.getErrorMessage(error),
      );

      if (status === 401 || status === 403) {
        this.clearState();

        throw new BadRequestException(
          'Session راهکاران معتبر نیست یا منقضی شده است.',
        );
      }

      throw error;
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

    this.logger.debug(`RSA plainText length: ${plainText.length}`);
    this.logger.debug(`RSA plainText: ${plainText}`);

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

    const response = await this.request<
      RahkaranResponse<RahkaranRetailProduct[]>
    >(
      `${this.baseUrl}/Retail/Api/Structure/ProductService.svc/GetProducts?${params.toString()}`,
      {
        method: 'GET',
        headers: this.authHeaders(),
      },
    );

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
  ): Promise<any> {
    const params = new URLSearchParams({
      barcode,
      page: String(page),
      count: String(count),
    });

    const url =
      `${this.baseUrl}/Retail/Api/Structure/ProductService.svc/` +
      `getProductByBarcode?${params.toString()}`;

    let response = await this.authenticatedRequest<any>(url, {
      method: 'GET',
    });

    // اگر Session منقضی شده باشد ولی HTTP 200 برگشته باشد
    if (this.isSessionExpiredResponse(response)) {
      this.logger.warn(
        `⚠️ Session هنگام دریافت SKU=${barcode} منقضی شده بود. Login مجدد...`,
      );

      this.clearState();

      await this.login();

      response = await this.request<any>(url, {
        method: 'GET',
        headers: this.authHeaders(),
      });
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

    const response = await this.request<
      RahkaranResponse<RahkaranRetailProduct>
    >(
      `${this.baseUrl}/Retail/Api/Structure/ProductService.svc/GetProduct?id=${productId}`,
      {
        method: 'GET',
        headers: this.authHeaders(),
      },
    );

    if (response?.metadata?.isSuccessfull !== true) {
      throw new BadRequestException(
        response?.metadata?.errorMessage || 'دریافت محصول راهکاران ناموفق بود.',
      );
    }

    return response.result;
  }

  async getRemainingQuantityInfo(
    productId: number,
  ): Promise<RahkaranRemainingQuantity[]> {
    await this.ensureAuthenticated();

    const response = await this.request<{
      result: RahkaranRemainingQuantity[];
      metadata?: {
        isSuccessfull?: boolean;
        errorMessage?: string | null;
      };
    }>(
      `${this.baseUrl}/Retail/Api/DocumentStructure/StoreService.svc/GetRemainingQuantityInfo`,
      {
        method: 'GET',
        params: {
          productId,
        },
        headers: this.authHeaders(),
      },
    );

    if (response?.metadata?.isSuccessfull === false) {
      throw new BadRequestException(
        response.metadata.errorMessage ||
          `دریافت موجودی محصول ${productId} از راهکاران ناموفق بود.`,
      );
    }

    return response?.result ?? [];
  }

  async createLoyaltyMemberForUser(id: number) {
    const user = await this.usersService.findOne(id);

    if (!user) {
      throw new BadRequestException('کاربر پیدا نشد');
    }

    const fullName = user.fullName?.trim() || '';

    const parts = fullName.split(/\s+/);

    const firstName = parts.shift() || '';
    const lastName = parts.join(' ');

    const response = await this.request(
      `${this.baseUrl}/Retail/Api/Structure/CustomerService.svc/customer`,
      {
        method: 'POST',
        data: {
          partyType: 0,
          Id: id,
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

    const loyalityResponse = await this.request(
      `${this.baseUrl}/Retail/LoyaltyApi/RetailLoyaltyMemberService.svc/loyaltyMember`,
      {
        method: 'POST',
        data: {
          loyaltyMemberPatternId: 3,
          customerId: id,
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

  async createSalesInvoice(
    input: CreateRahkaranInvoiceInput,
  ): Promise<RahkaranInvoiceResponse> {
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

    const inventoryId = 20;

    const settlementPolicyId = 9;

    const documentPatternId = 3;

    const items = input.items.map(item => ({
      Id: 0,

      inventoryId,

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

    this.logger.log(
      `🧾 ثبت فاکتور فروش در راهکاران برای مشتری ${input.customerId}`,
    );

    this.logger.debug(`Rahkaran invoice payload: ${JSON.stringify(payload)}`);

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
    );

    if (!this.isSuccessful(response)) {
      throw new BadRequestException(
        this.getRahkaranError(response) ||
          'ثبت فاکتور فروش در راهکاران ناموفق بود.',
      );
    }

    const result = response?.result ?? response;

    this.logger.log(
      `✅ فاکتور راهکاران با موفقیت ثبت شد. ` +
        `ID: ${result?.id ?? result?.invoiceId ?? 'unknown'} ` +
        `Number: ${result?.number ?? 'unknown'}`,
    );

    return result;
  }

  async syncOrderToRahkaran(order: {
    id: number;
    orderNumber: string;
    finalPrice: number;
    user: {
      id: number;
    };
    items: Array<{
      quantity: number;
      price: number;
      variant: {
        sku: string | null;
      };
    }>;
  }) {
    await this.ensureAuthenticated();

    if (!order.items?.length) {
      throw new BadRequestException(
        `سفارش ${order.id} آیتمی برای ثبت در راهکاران ندارد.`,
      );
    }

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

      const productResponse = await this.getRetailProductByBarcode(sku);

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

      invoiceItems.push({
        productId: Number(rahkaranProduct.productId),

        unitId: Number(unitId),

        quantity: Number(item.quantity),

        // قیمت پایه خود Rahkaran
        fee: rahkaranFee,

        // قیمت فروش ثبت‌شده در Order
        price: Number(item.price),
      });

      this.logger.log(
        `🛒 Order ${order.id} -> ` +
          `SKU ${sku} -> Rahkaran Product ${rahkaranProduct.productId}`,
      );
    }

    // =====================================================
    // ثبت فاکتور
    // =====================================================

    const invoice = await this.createSalesInvoice({
      customerId: Number(order.user.id),

      items: invoiceItems,

      inventoryId: 3,

      settlementPolicyId: 61,

      documentPatternId: 1,

      salesAgentId: 4,

      receiptAmount: Number(order.finalPrice),

      description: `Order ${order.orderNumber}`,
    });

    return invoice;
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
  ): Promise<T> {
    await this.ensureAuthenticated();

    try {
      return await this.request<T>(url, {
        ...config,
        headers: {
          ...(config.headers || {}),
          ...this.authHeaders(),
        },
      });
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
        `⚠️ Session راهکاران معتبر نیست. Login مجدد انجام می‌شود. Error: ${message}`,
      );

      this.clearState();

      await this.login();

      this.logger.log(
        '🔄 Login مجدد موفق بود. درخواست Rahkaran دوباره ارسال می‌شود.',
      );

      return await this.request<T>(url, {
        ...config,
        headers: {
          ...(config.headers || {}),
          ...this.authHeaders(),
        },
      });
    }
  }
}
