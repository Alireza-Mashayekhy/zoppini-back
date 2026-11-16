import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';
import {
  createCorrelationId,
  maskMobile,
  serializeError,
  structuredLog,
} from 'src/common/logging/structured-logger';

// ============================================================
// Types
// ============================================================

/** زمینهٔ ردیابی برای لاگ‌های ساختاریافتهٔ یک درخواست به دایاتک. */
export interface DiatechRequestContext {
  correlationId?: string;
  orderId?: number;
  /** مرحلهٔ جاری فرآیند (برای لاگ خطا) */
  stage?: string;
}

interface DiatechTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

interface DiatechResponse<T> {
  Succeeded: boolean;
  Payload: T;
  Errors?: Array<{
    Code?: string;
    Message?: string;
  }>;
}

export interface DiatechCustomer {
  Id?: number;
  FirstName: string;
  LastName: string;
  CustomerCode: string;
  OfficeId?: number | null;
  GenderType?: string | null;
  BirthDate?: string | null;
  TotalPoint?: number;
  AvailableCredit?: number;
  CardNumber?: string | null;
  Email?: string | null;
  NationalCode?: string | null;
  StateName?: string | null;
  CityName?: string | null;
  Address?: string | null;
  RegisterDate?: string | null;
  Coupons?: DiatechCoupon[];
  ExtendedProperties?: Array<{ Name: string; Value: string }>;
  Categories?: string[];
  Tags?: string[];
  Wallets?: DiatechCustomerWallet[];
}

export interface DiatechCustomerWallet {
  Id: number;
  OfficeId?: number | null;
  WalletId?: number | null;
  AvailableCredit: number;
}

export interface DiatechCoupon {
  Id: number;
  /** 1 = عمومی، 2 = خصوصی */
  CouponTypeIndex: number;
  Title: string;
  Code: string;
  IsActive: boolean;
  IsSystem: boolean;
  CouponPrice: number;
  SerialNumber?: number | null;
  /** 1 = درصدی، 2 = مبلغی */
  DiscountTypeIndex: number;
  DiscountValue: number;
  /** 1 = بازه زمانی، 2 = تعداد روز بعد از تخصیص */
  ExpireTypeIndex: number;
  StartDate?: string | null;
  ExpireDate?: string | null;
  ExpireDaysAfterAssignment?: number | null;
  MaximumDiscountPrice?: number | null;
  MinimumOrderPrice?: number | null;
  NumberOfUse?: number | null;
  NumberOfUsePerCustomer?: number | null;
  IsUseAlone: boolean;
  OfficeId?: number | null;
  IsUsed: boolean;
  CreateDate?: string;
}

export interface DiatechWalletWithOffice {
  Wallet?: string | null;
  Office?: string | null;
}

export interface DiatechLoyaltyHistory {
  Id: number;
  Date: string;
  PersianDate?: string;
  ProgramTypeIndex: number;
  ProgramType?: string;
  Point?: number | null;
  PersianPoint?: string | null;
  Credit?: number | null;
  PersianCredit?: string | null;
  PriceListId?: number | null;
  PriceListName?: string | null;
  CouponId?: number | null;
  CouponName?: string | null;
  LuckyWheelHistoryId?: number | null;
  Description?: string | null;
  CustomerId?: number | null;
  CustomerFullName?: string | null;
  OfficeId?: number | null;
  OfficeName?: string | null;
  WalletWithOfficeName?: DiatechWalletWithOffice | null;
  RelatedCustomerActivityId?: number | null;
  RelatedActivity?: string | null;
  CustomerRemainingCredit?: number | null;
  PersianCustomerRemainingCredit?: string | null;
  CreditExpireDate?: string | null;
  PersianCreditExpireDate?: string | null;
  IsExpireCredit?: boolean;
}

export interface DiatechLoyaltyLevel {
  Id: number;
  Title: string;
  FromPoint?: number | null;
  ToPoint?: number | null;
  /** غلط املایی موجود در مستند دایاتک */
  Prioprity?: number;
  Description?: string | null;
}

export interface DiatechWalletTransaction {
  Id: number;
  CustomerWalletId?: number;
  /** فیلدهای این DTO در مستند دایاتک جدول ندارند؛ به‌صورت منعطف مصرف می‌شود */
  [key: string]: unknown;
}

export interface DiatechPayment {
  Id: number;
  CustomerId?: number;
  /** فیلدهای این DTO در مستند دایاتک جدول ندارند؛ به‌صورت منعطف مصرف می‌شود */
  [key: string]: unknown;
}

export interface DiatechInvoiceDetail {
  Id?: number | null;

  ProductCode: string;

  ProductDescription?: string;

  Count: number;

  Price: number;

  TotalPrice: number;

  DiscountPrice?: number;

  TaxPrice?: number;

  FinalPrice: number;
}

export interface DiatechInvoice {
  Id?: number;
  CustomerId: number;
  officeId: number;
  /**
   * جمع کل فاکتور (ریال) — طبق مستند دایاتک مبلغ کلی فاکتور است
   * و کسورات (اعتبار/بن) از آن کم نمی‌شود.
   */
  FinalPrice: number;
  /** اعتبار مصرف‌شده از کیف پول مشتری، ریال */
  CurrentCredit?: number;
  /**
   * مبلغ نهایی فاکتور بعد از کسورات (ریال) — طبق مستند دایاتک:
   * `FinalValue = FinalPrice - CurrentCredit - CouponPrice`
   *
   * ارسال این فیلد الزامی است؛ بدون آن مبلغ نهایی در دایاتک
   * صفر/نامعتبر ثبت می‌شود.
   */
  FinalValue?: number;
}

// ============================================================
// Service
// ============================================================

@Injectable()
export class ClubService {
  private readonly logger = new Logger(ClubService.name);

  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;

  private accessToken: string | null = null;
  private tokenExpiresAt: number | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl =
      this.configService
        .get<string>('DIATECH_CLUB_BASE_URL')
        ?.replace(/\/$/, '') || '';

    this.username =
      this.configService.get<string>('DIATECH_CLUB_USERNAME') || '';

    this.password =
      this.configService.get<string>('DIATECH_CLUB_PASSWORD') || '';

    if (!this.baseUrl) {
      this.logger.warn('⚠️ DIATECH_CLUB_BASE_URL تنظیم نشده است.');
    }
  }

  // ============================================================
  // Token
  // ============================================================

  private async getAccessToken(): Promise<string> {
    /**
     * کمی زودتر از expire واقعی token را refresh می‌کنیم.
     */
    if (
      this.accessToken &&
      this.tokenExpiresAt &&
      Date.now() < this.tokenExpiresAt
    ) {
      return this.accessToken;
    }

    if (this.tokenRequest) {
      return this.tokenRequest;
    }

    this.tokenRequest = this.fetchAccessToken();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = null;
    }
  }

  private async fetchAccessToken(): Promise<string> {
    if (!this.username || !this.password) {
      throw new BadRequestException(
        'اطلاعات اتصال به باشگاه دایاتک کامل نیست.',
      );
    }

    try {
      const body = new URLSearchParams();

      // طبق مستند دایاتک
      body.append('grant_type', 'password');
      body.append('username', this.username);
      body.append('password', this.password);

      const response = await firstValueFrom(
        this.httpService.post<DiatechTokenResponse>(
          `${this.baseUrl}/api/token`,
          body.toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        ),
      );

      const token = response.data?.access_token;

      if (!token) {
        throw new Error('access_token از دایاتک دریافت نشد.');
      }

      const expiresIn = Number(response.data?.expires_in) || 1800;

      /**
       * 60 ثانیه قبل از expire دوباره token می‌گیریم.
       */
      this.tokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 30) * 1000;

      this.accessToken = token;

      this.logger.log(
        `✅ توکن باشگاه دایاتک دریافت شد. expiresIn=${expiresIn}s`,
      );

      return token;
    } catch (error) {
      this.accessToken = null;
      this.tokenExpiresAt = null;

      this.logger.error(
        '❌ خطا در دریافت توکن باشگاه دایاتک',
        this.getErrorMessage(error),
      );

      throw new BadRequestException('خطا در احراز هویت با باشگاه مشتریان.');
    }
  }

  // ============================================================
  // HTTP
  // ============================================================

  private async request<T>(
    config: AxiosRequestConfig,
    retryUnauthorized = true,
  ): Promise<T> {
    const startedAt = Date.now();

    try {
      const token = await this.getAccessToken();

      const response = await firstValueFrom(
        this.httpService.request<T>({
          ...config,

          baseURL: this.baseUrl,

          headers: {
            ...(config.headers || {}),

            Authorization: `Bearer ${token}`,

            'Content-Type': 'application/json',
          },
        }),
      );

      this.logger.debug(
        structuredLog('diatech.http.response', {
          method: config.method,
          url: this.maskUrl(config.url),
          httpStatus: response.status,
          durationMs: Date.now() - startedAt,
        }),
      );

      return this.normalizeDiatechResponse(response.data) as T;
    } catch (error) {
      const axiosError = error as AxiosError<any>;

      const status = axiosError.response?.status;

      /**
       * اگر token منقضی شده باشد،
       * یک بار token را پاک می‌کنیم.
       *
       * درخواست بعدی token جدید می‌گیرد.
       */
      if (status === 401) {
        this.accessToken = null;
        this.tokenExpiresAt = null;

        if (retryUnauthorized) {
          return this.request<T>(config, false);
        }
      }

      this.logger.error(
        structuredLog('diatech.http.error', {
          method: config.method,
          url: this.maskUrl(config.url),
          httpStatus: status,
          durationMs: Date.now() - startedAt,
          error: serializeError(error),
        }),
      );

      if (status === 404) {
        throw new NotFoundException('اطلاعات در باشگاه مشتریان یافت نشد.');
      }

      if (status === 400) {
        throw new BadRequestException(
          this.getErrorMessage(error) || 'درخواست باشگاه مشتریان نامعتبر است.',
        );
      }

      if (status && status >= 500) {
        throw new BadGatewayException(
          'سرویس باشگاه مشتریان موقتاً در دسترس نیست.',
        );
      }

      throw error;
    }
  }

  // ============================================================
  // Customer
  // ============================================================

  /**
   * ثبت یا ویرایش مشتری در باشگاه دایاتک
   *
   * POST /api/v1/customers
   */
  async registerCustomer(data: {
    firstName: string;
    lastName: string;
    customerCode: string;
    email?: string | null;
    birthDate?: string | null;
    nationalCode?: string | null;
    officeId?: number | null;
    genderType?: string | null;
    stateName?: string | null;
    cityName?: string | null;
    address?: string | null;
  }): Promise<DiatechCustomer> {
    const payload: DiatechCustomer = {
      FirstName: data.firstName,
      LastName: data.lastName,

      /**
       * طبق مستند:
       * CustomerCode = کد مشتری / شماره موبایل
       */
      CustomerCode: data.customerCode,

      OfficeId: data.officeId ?? null,

      Email: data.email || null,

      BirthDate: data.birthDate || null,

      NationalCode: data.nationalCode || null,

      GenderType: data.genderType || null,

      StateName: data.stateName || null,

      CityName: data.cityName || null,

      Address: data.address || null,
    };

    try {
      const response = await this.request<DiatechResponse<DiatechCustomer>>({
        method: 'POST',
        url: '/api/v1/customers',
        data: payload,
      });

      this.checkResponse(response, 'ثبت مشتری در باشگاه دایاتک');

      this.logger.log(
        `✅ مشتری ${maskMobile(data.customerCode)} در باشگاه دایاتک ثبت شد.`,
      );

      return response.Payload;
    } catch (error) {
      this.logger.error(
        `❌ ثبت مشتری ${maskMobile(data.customerCode)} در باشگاه دایاتک ناموفق بود.`,
        this.getErrorMessage(error),
      );

      throw error;
    }
  }

  /**
   * دریافت مشتری با CustomerCode
   *
   * GET /api/v1/customers/{customerCode}/office/{officeId?}
   */
  async getCustomer(customerCode: string): Promise<DiatechCustomer> {
    const encodedCustomerCode = encodeURIComponent(customerCode);

    const url = `/api/v1/customers/${encodedCustomerCode}/office`;

    const response = await this.request<DiatechResponse<DiatechCustomer>>({
      method: 'GET',
      url,
    });

    this.checkResponse(response, 'دریافت مشتری از باشگاه دایاتک');

    return response.Payload;
  }

  // ============================================================
  // Customer Wallets
  // ============================================================

  /**
   * دریافت کیف پول‌های مشتری
   *
   * GET /api/v1/customers/{customerCode}/wallets
   * GET /api/v1/customers/{customerCode}/wallets/office/{officeId}
   */
  async getCustomerWallets(
    customerCode: string,
    officeId?: number,
  ): Promise<DiatechCustomerWallet[]> {
    const encodedCustomerCode = encodeURIComponent(customerCode);

    const url =
      officeId != null
        ? `/api/v1/customers/${encodedCustomerCode}/wallets/office/${officeId}`
        : `/api/v1/customers/${encodedCustomerCode}/wallets`;

    const response = await this.request<
      DiatechResponse<DiatechCustomerWallet[]>
    >({
      method: 'GET',
      url,
    });

    this.checkResponse(response, 'دریافت کیف پول‌های مشتری از باشگاه دایاتک');

    return response.Payload ?? [];
  }

  /**
   * دریافت تراکنش‌های کیف پول مشتری
   *
   * GET /api/v1/wallet-transactions/customer-wallet/{customerWalletId}
   */
  async getCustomerWalletTransactions(
    customerWalletId: number,
  ): Promise<DiatechWalletTransaction[]> {
    const response = await this.request<
      DiatechResponse<DiatechWalletTransaction[]>
    >({
      method: 'GET',
      url: `/api/v1/wallet-transactions/customer-wallet/${customerWalletId}`,
    });

    this.checkResponse(response, 'دریافت تراکنش‌های کیف پول از باشگاه دایاتک');

    return response.Payload ?? [];
  }

  // ============================================================
  // Loyalty
  // ============================================================

  /**
   * دریافت تاریخچه وفاداری مشتری (امتیاز / اعتبار / بن)
   *
   * GET /api/v1/loyalty/{customerCode}/Histories
   */
  async getCustomerLoyaltyHistories(
    customerCode: string,
  ): Promise<DiatechLoyaltyHistory[]> {
    const encodedCustomerCode = encodeURIComponent(customerCode);

    const response = await this.request<
      DiatechResponse<DiatechLoyaltyHistory[]>
    >({
      method: 'GET',
      url: `/api/v1/loyalty/${encodedCustomerCode}/Histories`,
    });

    this.checkResponse(response, 'دریافت تاریخچه وفاداری از باشگاه دایاتک');

    return response.Payload ?? [];
  }

  /**
   * دریافت سطوح وفاداری
   *
   * GET /api/v1/loyalty/levels
   */
  async getLoyaltyLevels(): Promise<DiatechLoyaltyLevel[]> {
    const response = await this.request<DiatechResponse<DiatechLoyaltyLevel[]>>(
      {
        method: 'GET',
        url: '/api/v1/loyalty/levels',
      },
    );

    this.checkResponse(response, 'دریافت سطوح وفاداری از باشگاه دایاتک');

    return response.Payload ?? [];
  }

  // ============================================================
  // Payments
  // ============================================================

  /**
   * دریافت پرداختی‌ها و دریافتی‌های مشتری
   *
   * GET /api/v1/payments/customer/{customerCode}
   */
  async getCustomerPayments(customerCode: string): Promise<DiatechPayment[]> {
    const encodedCustomerCode = encodeURIComponent(customerCode);

    const response = await this.request<DiatechResponse<DiatechPayment[]>>({
      method: 'GET',
      url: `/api/v1/payments/customer/${encodedCustomerCode}`,
    });

    this.checkResponse(response, 'دریافت پرداختی‌های مشتری از باشگاه دایاتک');

    return response.Payload ?? [];
  }

  // ============================================================
  // Invoice
  // ============================================================

  /**
   * تبدیل مبلغ تومانی فرم سفارش به ریال با اعتبارسنجی.
   *
   * مبالغ نامعتبر (NaN/Infinity) یا منفی مجاز نیستند؛ هیچ‌وقت نباید
   * مبلغ صفر/محاسبه‌نشده به دایاتک ارسال شود.
   */
  private toRialAmount(
    value: unknown,
    fieldName: string,
    options: { allowZero?: boolean } = {},
  ): number {
    const toman = Number(value);

    if (!Number.isFinite(toman)) {
      throw new BadRequestException(
        `${fieldName} برای ثبت فاکتور دایاتک معتبر نیست (مقدار: ${String(
          value,
        )}).`,
      );
    }

    if (toman < 0 || (toman === 0 && !options.allowZero)) {
      throw new BadRequestException(
        `${fieldName} برای ثبت فاکتور دایاتک نمی‌تواند ${
          toman === 0 ? 'صفر' : 'منفی'
        } باشد.`,
      );
    }

    return Math.round(toman * 10);
  }

  /**
   * ثبت یا ویرایش فاکتور فروش در دایاتک
   *
   * POST /api/v1/invoices
   *
   * قرارداد دایاتک (مستند InvoiceDto):
   * - `FinalPrice` = جمع کل فاکتور (ریال)
   * - `CurrentCredit` = میزان خرج اعتبار مشتری (ریال)
   * - `FinalValue` = مبلغ نهایی بعد از کسورات = FinalPrice - CurrentCredit
   *   (بن تخفیف/CouponPrice در این جریان استفاده نمی‌شود)
   *
   * هر دو فیلد FinalPrice و FinalValue باید همیشه با مقدار معتبر ارسال شوند.
   */
  async createInvoice(
    data: {
      customerCode: string;
      finalPrice: number;
      currentCredit?: number;
    },
    context?: DiatechRequestContext,
  ): Promise<DiatechInvoice> {
    const correlationId =
      context?.correlationId ?? createCorrelationId('diatech-inv');

    const startedAt = Date.now();

    // ============================================================
    // 1. اعتبارسنجی و تبدیل مبالغ (تومان -> ریال)
    // ============================================================

    const finalPriceRial = this.toRialAmount(data.finalPrice, 'FinalPrice');

    const creditRial = this.toRialAmount(
      data.currentCredit ?? 0,
      'CurrentCredit',
      { allowZero: true },
    );

    // اعتبار مصرف‌شده هرگز نمی‌تواند از جمع کل فاکتور بیشتر باشد.
    const currentCreditRial = Math.min(creditRial, finalPriceRial);

    if (creditRial > finalPriceRial) {
      this.logger.warn(
        structuredLog('diatech.invoice.credit_clamped', {
          correlationId,
          orderId: context?.orderId,
          requestedCreditRial: creditRial,
          finalPriceRial,
        }),
      );
    }

    // طبق قرارداد دایاتک: مبلغ نهایی بعد از کسورات (اعتبار مشتری)
    const finalValueRial = finalPriceRial - currentCreditRial;

    this.logger.log(
      structuredLog('diatech.invoice.create.start', {
        correlationId,
        orderId: context?.orderId,
        customerCode: maskMobile(data.customerCode),
        finalPriceRial,
        currentCreditRial,
        finalValueRial,
      }),
    );

    // ============================================================
    // 2. پیدا کردن مشتری در دایاتک
    // ============================================================

    let customer: DiatechCustomer;

    try {
      customer = await this.getCustomer(data.customerCode);
    } catch (error) {
      this.logger.error(
        structuredLog('diatech.invoice.create.failed', {
          correlationId,
          orderId: context?.orderId,
          stage: 'resolve_customer',
          customerCode: maskMobile(data.customerCode),
          durationMs: Date.now() - startedAt,
          error: serializeError(error),
        }),
      );

      throw error;
    }

    if (!customer?.Id) {
      const error = new BadRequestException(
        `مشتری با کد ${data.customerCode} در باشگاه دایاتک پیدا نشد.`,
      );

      this.logger.error(
        structuredLog('diatech.invoice.create.failed', {
          correlationId,
          orderId: context?.orderId,
          stage: 'resolve_customer',
          customerCode: maskMobile(data.customerCode),
          durationMs: Date.now() - startedAt,
          error: serializeError(error),
        }),
      );

      throw error;
    }

    this.logger.log(
      structuredLog('diatech.invoice.customer_resolved', {
        correlationId,
        orderId: context?.orderId,
        customerId: customer.Id,
        customerCode: maskMobile(data.customerCode),
      }),
    );

    // ============================================================
    // 3. ساخت Payload فاکتور
    // ============================================================

    const payload: DiatechInvoice = {
      CustomerId: customer.Id,

      officeId: 1,

      FinalPrice: finalPriceRial,
      CurrentCredit: currentCreditRial,
      FinalValue: finalValueRial,
    };

    this.logger.debug(
      structuredLog('diatech.invoice.payload', {
        correlationId,
        orderId: context?.orderId,
        customerId: customer.Id,
        officeId: payload.officeId,
        FinalPrice: payload.FinalPrice,
        CurrentCredit: payload.CurrentCredit,
        FinalValue: payload.FinalValue,
      }),
    );

    // ============================================================
    // 4. ثبت فاکتور
    // ============================================================

    try {
      const response = await this.request<DiatechResponse<DiatechInvoice>>({
        method: 'POST',
        url: '/api/v1/invoices',
        data: payload,
      });

      this.checkResponse(response, 'ثبت فاکتور فروش در باشگاه دایاتک');

      this.logger.log(
        structuredLog('diatech.invoice.create.response', {
          correlationId,
          orderId: context?.orderId,
          customerId: customer.Id,
          invoiceId: response.Payload?.Id ?? null,
          finalPriceRial,
          finalValueRial,
          durationMs: Date.now() - startedAt,
        }),
      );

      return response.Payload;
    } catch (error) {
      this.logger.error(
        structuredLog('diatech.invoice.create.failed', {
          correlationId,
          orderId: context?.orderId,
          stage: 'save_invoice',
          customerId: customer.Id,
          finalPriceRial,
          currentCreditRial,
          finalValueRial,
          durationMs: Date.now() - startedAt,
          error: serializeError(error),
        }),
      );

      throw error;
    }
  }

  /**
   * دریافت فاکتور بر اساس شماره فاکتور
   *
   * GET /api/v1/invoices/{number}/office/{officeId}
   */
  async getInvoice(number: string, officeId: number): Promise<DiatechInvoice> {
    const encodedNumber = encodeURIComponent(number);

    const response = await this.request<DiatechResponse<DiatechInvoice>>({
      method: 'GET',
      url: `/api/v1/invoices/${encodedNumber}/office/${officeId}`,
    });

    this.checkResponse(response, 'دریافت فاکتور از باشگاه دایاتک');

    return response.Payload;
  }

  /**
   * تایید فاکتور
   *
   * POST /api/v1/invoices/{id}/approve
   */
  async approveInvoice(
    invoiceId: number,
    context?: DiatechRequestContext,
  ): Promise<DiatechInvoice> {
    const correlationId =
      context?.correlationId ?? createCorrelationId('diatech-inv');

    const startedAt = Date.now();

    try {
      const response = await this.request<DiatechResponse<DiatechInvoice>>({
        method: 'POST',
        url: `/api/v1/invoices/${invoiceId}/approve`,
      });

      this.checkResponse(response, 'تایید فاکتور در باشگاه دایاتک');

      this.logger.log(
        structuredLog('diatech.invoice.approved', {
          correlationId,
          orderId: context?.orderId,
          invoiceId,
          durationMs: Date.now() - startedAt,
        }),
      );

      return response.Payload;
    } catch (error) {
      this.logger.error(
        structuredLog('diatech.invoice.approve.failed', {
          correlationId,
          orderId: context?.orderId,
          stage: 'approve_invoice',
          invoiceId,
          durationMs: Date.now() - startedAt,
          error: serializeError(error),
        }),
      );

      throw error;
    }
  }

  /**
   * حذف فاکتور
   *
   * POST /api/v1/invoices/{id}/delete
   */
  async deleteInvoice(invoiceId: number): Promise<any> {
    const response = await this.request<any>({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/delete`,
    });

    this.checkResponse(response, 'حذف فاکتور از باشگاه دایاتک');

    return response.Payload;
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Diatech deployments may serialize the same .NET DTO in either PascalCase
   * or camelCase (depending on their serializer configuration). Normalize the
   * wire response once here so every club endpoint consumes one stable shape.
   */
  private normalizeDiatechResponse<T>(value: T): DiatechResponse<unknown> {
    const normalized = this.normalizeDiatechKeys(value);

    if (Array.isArray(normalized)) {
      return { Succeeded: true, Payload: normalized };
    }

    if (!normalized || typeof normalized !== 'object') {
      return { Succeeded: true, Payload: normalized };
    }

    const response = normalized as Record<string, unknown>;
    const hasEnvelope =
      Object.prototype.hasOwnProperty.call(response, 'Succeeded') ||
      Object.prototype.hasOwnProperty.call(response, 'Success') ||
      Object.prototype.hasOwnProperty.call(response, 'Payload') ||
      Object.prototype.hasOwnProperty.call(response, 'Errors');

    if (hasEnvelope) {
      // Some API versions use the generic { success, data } envelope.
      if (response.Succeeded === undefined && response.Success !== undefined) {
        response.Succeeded = response.Success;
      }
      if (response.Payload === undefined && response.Data !== undefined) {
        response.Payload = response.Data;
      }

      // System.Text.Json (PreserveReferencesHandling) and a few paged
      // endpoints wrap the DTO one level deeper (`{ $values: [...] }`,
      // `{ Items: [...], TotalCount }`, `{ Results: [...] }`). Unwrap it
      // here so the Next app always receives the real list.
      response.Payload = this.unwrapPayload(response.Payload);

      return response as unknown as DiatechResponse<unknown>;
    }

    // Also tolerate endpoints that return the DTO directly rather than the
    // standard { Succeeded, Payload } envelope.
    return { Succeeded: true, Payload: this.unwrapPayload(normalized) };
  }

  /**
   * اگر Payload خودش یک پوشش دیگر باشد (`{ $values }`، `{ Items }`،
   * `{ Results }`، `{ Data }`)، یک لایه باز می‌شود.
   */
  private unwrapPayload(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const inner = this.findListOrDto(value as Record<string, unknown>);

    return inner === undefined ? value : inner;
  }

  private findListOrDto(response: Record<string, unknown>): unknown {
    for (const key of [
      'Payload',
      'payload',
      'Data',
      'data',
      'Items',
      'items',
      'Results',
      'results',
      'Records',
      'records',
      'List',
      'list',
      '$values',
    ]) {
      if (!Object.prototype.hasOwnProperty.call(response, key)) continue;

      return response[key];
    }

    return undefined;
  }

  private normalizeDiatechKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(item => this.normalizeDiatechKeys(item));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        const normalizedKey = key.length
          ? `${key[0].toUpperCase()}${key.slice(1)}`
          : key;
        return [normalizedKey, this.normalizeDiatechKeys(item)];
      }),
    );
  }

  /**
   * ماسک مقادیر طولانی عددی (مثل CustomerCode = شماره موبایل) در path
   * endpoint تا اطلاعات کاربران در لاگ افشا نشود.
   */
  private maskUrl(url?: string): string | undefined {
    if (!url) {
      return url;
    }

    return url
      .split('?')[0]
      .replace(/\d{7,}/g, digits => maskMobile(digits) ?? '***');
  }

  private checkResponse(
    response: DiatechResponse<any>,
    operation: string,
  ): void {
    if (!response) {
      throw new BadRequestException(
        `${operation}: پاسخ خالی از دایاتک دریافت شد.`,
      );
    }

    if (response.Succeeded === true) {
      return;
    }

    this.logger.log(response);

    const errors = response.Errors || [];

    const message =
      errors
        .map(error => error?.Message)
        .filter(Boolean)
        .join(' | ') || `${operation} ناموفق بود.`;

    throw new BadRequestException(message);
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof AxiosError) {
      const data = error.response?.data;

      if (typeof data === 'string') {
        return data;
      }

      if (data) {
        return JSON.stringify(data);
      }

      return error.message;
    }

    if (error instanceof Error) {
      return error.message;
    }

    if (error && typeof error === 'object') {
      return JSON.stringify(error);
    }

    return String(error);
  }
}
