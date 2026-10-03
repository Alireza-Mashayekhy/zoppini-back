import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DigipayAuthService {
  private readonly logger = new Logger(DigipayAuthService.name);

  private accessToken: string | null = null;
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

    this.tokenRequest = this.requestAccessToken();

    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = null;
    }
  }

  /** در صورت دریافت 401، توکن cache شده نباید دوباره استفاده شود. */
  clearToken(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  private async requestAccessToken(): Promise<string> {
    const url = `${this.getBaseUrl()}/oauth/token`;

    try {
      const clientId = this.getClientId();
      const clientSecret = this.getClientSecret();
      const username = this.getUsername();
      const password = this.getPassword();

      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
        'base64',
      );

      // طبق مستندات دیجی‌پی: multipart/form-data
      const formData = new FormData();

      formData.append('username', username);
      formData.append('password', password);
      formData.append('grant_type', 'password');

      this.logger.log(`درخواست توکن دیجی‌پی به ${url}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
        },
        body: formData,
      });

      const responseText = await response.text();

      let data: any;

      try {
        data = JSON.parse(responseText);
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

      this.logger.log('✅ توکن دیجی‌پی با موفقیت دریافت شد');

      return newToken;
    } catch (error: any) {
      this.logger.error('❌ خطا در دریافت توکن دیجی‌پی', error?.stack || error);

      throw new BadRequestException(
        error?.message || 'خطا در ارتباط با درگاه دیجی‌پی',
      );
    }
  }
}
