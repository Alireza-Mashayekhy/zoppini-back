import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';

// ============================================================
// Types
// ============================================================

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
  CustomerId: number;

  FinalPrice: number;
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

      this.logger.log(this.baseUrl, body);

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

  private async request<T>(config: AxiosRequestConfig): Promise<T> {
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

      return response.data;
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
      }

      this.logger.error(
        `❌ Diatech API Error ${status || ''}`,
        this.getErrorMessage(error),
      );

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

      this.logger.log(`✅ مشتری ${data.customerCode} در باشگاه دایاتک ثبت شد.`);

      return response.Payload;
    } catch (error) {
      this.logger.error(
        `❌ ثبت مشتری ${data.customerCode} در باشگاه دایاتک ناموفق بود.`,
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

    console.log(encodedCustomerCode);
    const url = `/api/v1/customers/${encodedCustomerCode}/office`;

    const response = await this.request<DiatechResponse<DiatechCustomer>>({
      method: 'GET',
      url,
    });

    this.checkResponse(response, 'دریافت مشتری از باشگاه دایاتک');

    return response.Payload;
  }

  // ============================================================
  // Invoice
  // ============================================================

  /**
   * ثبت یا ویرایش فاکتور فروش در دایاتک
   *
   * POST /api/v1/invoices
   */
  async createInvoice(data: {
    customerCode: string;
    finalPrice: number;
  }): Promise<DiatechInvoice> {
    // ============================================================
    // 1. پیدا کردن مشتری در دایاتک
    // ============================================================

    const customer = await this.getCustomer(data.customerCode);

    if (!customer?.Id) {
      throw new BadRequestException(
        `مشتری با کد ${data.customerCode} در باشگاه دایاتک پیدا نشد.`,
      );
    }

    this.logger.log(
      `✅ مشتری دایاتک پیدا شد. ` +
        `CustomerCode=${data.customerCode}, ` +
        `CustomerId=${customer.Id}`,
    );

    // ============================================================
    // 2. ساخت Payload فاکتور
    // ============================================================

    const payload: DiatechInvoice = {
      CustomerId: customer.Id,

      FinalPrice: Number(data.finalPrice) || 0,
    };

    // ============================================================
    // 3. ثبت فاکتور
    // ============================================================

    try {
      const response = await this.request<DiatechResponse<DiatechInvoice>>({
        method: 'POST',
        url: '/api/v1/invoices',
        data: payload,
      });

      this.checkResponse(response, 'ثبت فاکتور فروش در باشگاه دایاتک');

      this.logger.log(
        `✅ فاکتور در دایاتک ثبت شد. ` + `CustomerId=${customer.Id}`,
      );

      return response.Payload;
    } catch (error) {
      this.logger.error(
        `❌ ثبت فاکتور  در دایاتک ناموفق بود.`,
        this.getErrorMessage(error),
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
  async approveInvoice(invoiceId: number): Promise<DiatechInvoice> {
    const response = await this.request<DiatechResponse<DiatechInvoice>>({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/approve`,
    });

    this.checkResponse(response, 'تایید فاکتور در باشگاه دایاتک');

    this.logger.log(`✅ فاکتور دایاتک ${invoiceId} تایید شد.`);

    return response.Payload;
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

    return String(error);
  }
}
