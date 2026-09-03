import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class TaraAuthService {
  private readonly logger = new Logger(TaraAuthService.name);

  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  private getBaseUrl(): string {
    const baseUrl = this.configService.get<string>('TARA_API_URL');

    if (!baseUrl) {
      throw new Error('TARA_API_URL تنظیم نشده است');
    }

    return baseUrl.replace(/\/+$/, '');
  }

  private getUsername(): string {
    const username = this.configService.get<string>('TARA_USERNAME');

    if (!username) {
      throw new Error('TARA_USERNAME تنظیم نشده است');
    }

    return username;
  }

  private getPassword(): string {
    const password = this.configService.get<string>('TARA_PASSWORD');

    if (!password) {
      throw new Error('TARA_PASSWORD تنظیم نشده است');
    }

    return password;
  }

  private isTokenValid(): boolean {
    if (!this.accessToken || !this.tokenExpiresAt) {
      return false;
    }

    // 1 دقیقه قبل از انقضا دوباره token بگیر
    const now = Date.now();
    const expiresAt = this.tokenExpiresAt.getTime();

    return expiresAt - now > 60_000;
  }

  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.accessToken!;
    }

    const url = `${this.getBaseUrl()}/api/v2/authenticate`;

    const username = this.getUsername();
    const password = this.getPassword();

    const payload = {
      username,
      password,
    };

    // نام کاربری/رمز/توکن لاگ نمی‌شوند (نشتی اطلاعات حساس)
    this.logger.log(`درخواست توکن تارا: ${url}`);

    try {
      const response = await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },

          // نگذار Axios روی 403 مستقیماً throw کند
          validateStatus: () => true,
        }),
      );

      this.logger.log(`Tara auth status: ${response.status}`);

      /*
       * هر پاسخ غیر 2xx را خطا در نظر بگیر
       */
      if (response.status < 200 || response.status >= 300) {
        const message =
          response.data?.message ||
          response.data?.description ||
          response.data?.error ||
          response.statusText ||
          `Tara auth failed: HTTP ${response.status}`;

        throw new Error(message);
      }

      const data = response.data;

      /*
       * طبق مستند، خروجی سرویس لاگین شامل accessToken و همچنین
       * result (کد پاسخ) و description است؛ مثلاً:
       *   2 = نام کاربری یا رمز عبور نامعتبر است
       *   3 = کاربر دسترسی ندارد
       *   4 = پذیرنده یافت نشد
       */
      if (data?.result !== undefined && String(data.result) !== '0') {
        const message =
          data?.description || `احراز هویت تارا ناموفق (result=${data.result})`;

        this.logger.error(`❌ ${message}`);

        throw new Error(message);
      }

      const newToken = data?.accessToken || data?.access_token || data?.token;

      if (!newToken) {
        throw new Error(
          `توکن در پاسخ تارا موجود نیست${
            data?.description ? ` (${data.description})` : ''
          }`,
        );
      }

      this.accessToken = String(newToken);

      this.tokenExpiresAt = this.resolveExpireTime(data);

      this.logger.log(
        `✅ توکن تارا دریافت شد - expires: ${this.tokenExpiresAt.toISOString()}`,
      );

      return this.accessToken;
    } catch (error) {
      if (error.isAxiosError) {
        this.logger.error('❌ خطا در ارتباط با API تارا');

        this.logger.error(`Status: ${error.response?.status}`);

        this.logger.error(
          `Response: ${JSON.stringify(error.response?.data, null, 2)}`,
        );

        this.logger.error(`URL: ${error.config?.url}`);
      } else {
        this.logger.error('❌ خطا در دریافت توکن تارا');

        this.logger.error(error?.stack || error);
      }

      throw new BadRequestException('خطا در ارتباط با درگاه تارا');
    }
  }

  /**
   * محاسبهٔ زمان انقضای توکن.
   *
   * در مستند، expireTime از نوع long است؛ ممکن است epoch-milliseconds یا
   * epoch-seconds باشد. اگر مقدار قابل اتکا نبود (یا مربوط به گذشته بود)
   * به یک ساعت پیش‌فرض برمی‌گردیم تا توکن منقضی‌شده کش نماند.
   */
  private resolveExpireTime(data: any): Date {
    const fallback = () => new Date(Date.now() + 3600 * 1000);

    const expireTime = data?.expireTime;

    if (expireTime !== undefined && expireTime !== null && expireTime !== '') {
      const numeric = Number(expireTime);

      let candidate: Date | null = null;

      if (Number.isFinite(numeric) && numeric > 0) {
        // اعداد ۱۰ رقمی = ثانیه، ۱۳ رقمی به بالا = میلی‌ثانیه
        candidate = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
      } else {
        const parsed = new Date(expireTime);

        if (!Number.isNaN(parsed.getTime())) {
          candidate = parsed;
        }
      }

      // تاریخ گذشته/نامعتبر → کش کردن توکن بی‌فایده است
      if (candidate && candidate.getTime() > Date.now()) {
        return candidate;
      }

      this.logger.warn(
        `expireTime تارا قابل اتکا نبود (${String(expireTime)})؛ پیش‌فرض یک ساعت در نظر گرفته می‌شود.`,
      );

      return fallback();
    }

    if (data?.expiresIn) {
      return new Date(Date.now() + Number(data.expiresIn) * 1000);
    }

    if (data?.expires_in) {
      return new Date(Date.now() + Number(data.expires_in) * 1000);
    }

    return fallback();
  }

  clearToken(): void {
    this.accessToken = null;
    this.tokenExpiresAt = null;
  }
}
