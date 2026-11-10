import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** پاسخ موفق سرویس `oauth/token` دیجی‌پی (جدول ۲ مستند UPG) */
type DigipayTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
  message?: string;
};

/**
 * سرویس احراز هویت دیجی‌پی (بند ۶ مستند UPG).
 *
 * - `oauth/token` با `grant_type=password` و هدر `Authorization: Basic base64(client_id:client_secret)`
 * - توکن در حافظهٔ همین پروسه کش می‌شود و ۳۰ ثانیه پیش از انقضا کنار گذاشته
 *   می‌شود (حاشیهٔ اطمینان برای شبکه).
 * - پس از انقضای Access Token، طبق بند ۶-۲ مستند با `grant_type=refresh_token`
 *   توکن جدید گرفته می‌شود؛ اگر refresh_token هم رد شود، لاگین کامل انجام می‌شود.
 * - درخواست‌های همزمان با یک Promise مشترک سریال می‌شوند تا چند لاگین موازی
 *   به دیجی‌پی ارسال نشود.
 */
@Injectable()
export class DigipayAuthService {
  private readonly logger = new Logger(DigipayAuthService.name);

  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenRequest: Promise<string> | null = null;

  constructor(private readonly configService: ConfigService) {}

  private getRequiredConfig(name: string): string {
    const value = this.configService.get<string>(name)?.trim();

    if (!value) {
      throw new Error(`${name} تنظیم نشده است`);
    }

    return value;
  }

  private getBaseUrl(): string {
    return this.getRequiredConfig('DIGIPAY_API_URL').replace(/\/+$/, '');
  }

  private getClientId(): string {
    return this.getRequiredConfig('DIGIPAY_CLIENT_ID');
  }

  private getClientSecret(): string {
    return this.getRequiredConfig('DIGIPAY_CLIENT_SECRET');
  }

  private getUsername(): string {
    return this.getRequiredConfig('DIGIPAY_USERNAME');
  }

  private getPassword(): string {
    return this.getRequiredConfig('DIGIPAY_PASSWORD');
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiresAt > Date.now()) {
      return this.accessToken;
    }

    if (this.tokenRequest) {
      return this.tokenRequest;
    }

    this.tokenRequest = this.obtainToken();

    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = null;
    }
  }

  /**
   * در صورت دریافت 401/403، توکن cache شده نباید دوباره استفاده شود.
   * refresh_token هم پاک می‌شود تا اگر خودش هم نامعتبر شده باشد، دفعهٔ بعد
   * لاگین کامل انجام شود.
   */
  clearToken(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiresAt = 0;
  }

  private async obtainToken(): Promise<string> {
    if (this.refreshToken) {
      try {
        return await this.requestToken({
          grantType: 'refresh_token',
          refreshToken: this.refreshToken,
        });
      } catch (error: any) {
        // مستند ۶-۲: اگر refresh_token با 401 رد شود، باید لاگین دوباره انجام شود.
        this.logger.warn(
          `تمدید توکن دیجی‌پی با refresh_token ممکن نشد؛ لاگین کامل انجام می‌شود (${
            error?.message || error
          })`,
        );
        this.clearToken();
      }
    }

    return this.requestToken({ grantType: 'password' });
  }

  private async requestToken(params: {
    grantType: 'password' | 'refresh_token';
    refreshToken?: string;
  }): Promise<string> {
    const url = `${this.getBaseUrl()}/oauth/token`;

    try {
      const basicAuth = Buffer.from(
        `${this.getClientId()}:${this.getClientSecret()}`,
      ).toString('base64');

      // طبق مستندات دیجی‌پی: multipart/form-data
      const formData = new FormData();

      if (params.grantType === 'refresh_token') {
        formData.append('grant_type', 'refresh_token');
        formData.append('refresh_token', params.refreshToken ?? '');
      } else {
        formData.append('username', this.getUsername());
        formData.append('password', this.getPassword());
        formData.append('grant_type', 'password');
      }

      this.logger.log(`درخواست توکن دیجی‌پی (${params.grantType}) به ${url}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
        },
        body: formData,
      });

      const responseText = await response.text();

      let data: DigipayTokenResponse;

      try {
        data = JSON.parse(responseText) as DigipayTokenResponse;
      } catch {
        throw new Error('پاسخ دریافت توکن دیجی‌پی JSON معتبر نیست');
      }

      this.logger.log(`Digipay auth status: ${response.status}`);

      if (!response.ok) {
        if (response.status === 401) {
          this.clearToken();
        }

        throw new Error(
          data?.error_description ||
            data?.message ||
            `Digipay auth failed: ${response.status}`,
        );
      }

      const newToken =
        typeof data?.access_token === 'string' ? data.access_token.trim() : '';

      if (!newToken) {
        throw new Error('توکن در پاسخ دیجی‌پی موجود نیست');
      }

      const expiresIn = Number(data?.expires_in);

      const lifetimeSeconds =
        Number.isFinite(expiresIn) && expiresIn > 30 ? expiresIn : 3600;

      this.accessToken = newToken;
      this.tokenExpiresAt =
        Date.now() + Math.max(1, lifetimeSeconds - 30) * 1000;
      this.refreshToken =
        typeof data?.refresh_token === 'string' && data.refresh_token.trim()
          ? data.refresh_token.trim()
          : null;

      this.logger.log(
        params.grantType === 'refresh_token'
          ? '✅ توکن دیجی‌پی با refresh_token تمدید شد'
          : '✅ توکن دیجی‌پی با موفقیت دریافت شد',
      );

      return newToken;
    } catch (error: any) {
      this.logger.error(
        `❌ خطا در دریافت توکن دیجی‌پی (${params.grantType})`,
        error?.stack || error,
      );

      throw new BadRequestException(
        error?.message || 'خطا در ارتباط با درگاه دیجی‌پی',
      );
    }
  }
}
