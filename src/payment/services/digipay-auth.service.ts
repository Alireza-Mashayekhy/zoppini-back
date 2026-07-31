import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DigipayAuthService {
  private readonly logger = new Logger(DigipayAuthService.name);

  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  constructor(private configService: ConfigService) {}

  private getBaseUrl(): string {
    return this.configService.get<string>('DIGIPAY_API_URL')!;
  }

  private getClientId(): string {
    return this.configService.get<string>('DIGIPAY_CLIENT_ID')!;
  }

  private getClientSecret(): string {
    return this.configService.get<string>('DIGIPAY_CLIENT_SECRET')!;
  }

  private getUsername(): string {
    return this.configService.get<string>('DIGIPAY_USERNAME')!;
  }

  private getPassword(): string {
    return this.configService.get<string>('DIGIPAY_PASSWORD')!;
  }

  async getAccessToken(): Promise<string> {
    if (
      this.accessToken &&
      this.tokenExpiresAt &&
      this.tokenExpiresAt > new Date()
    ) {
      return this.accessToken;
    }

    const url = `${this.getBaseUrl()}/oauth/token`;

    try {
      const clientId = this.getClientId();
      const clientSecret = this.getClientSecret();

      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
        'base64',
      );

      // طبق مستندات دیجی‌پی: multipart/form-data
      const formData = new FormData();

      formData.append('username', this.getUsername());
      formData.append('password', this.getPassword());
      formData.append('grant_type', 'password');

      this.logger.log('========== DIGIPAY AUTH ==========');
      this.logger.log(`URL: ${url}`);
      this.logger.log(`Client ID: ${clientId}`);
      this.logger.log(`Client Secret length: ${clientSecret.length}`);
      this.logger.log(`Username: ${this.getUsername()}`);
      this.logger.log(`Password length: ${this.getPassword().length}`);
      this.logger.log('Body type: multipart/form-data');
      this.logger.log('==================================');

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
        },
        body: formData,
      });

      const responseText = await response.text();

      this.logger.log(`Digipay auth status: ${response.status}`);

      this.logger.log(`Digipay auth response: ${responseText}`);

      let data: any;

      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error('پاسخ دریافت توکن دیجی‌پی JSON معتبر نیست');
      }

      if (!response.ok) {
        throw new Error(
          data?.error_description ||
            data?.message ||
            `Digipay auth failed: ${response.status}`,
        );
      }

      const newToken = data.access_token;

      if (!newToken) {
        throw new Error('توکن در پاسخ دیجی‌پی موجود نیست');
      }

      this.accessToken = newToken;

      const expiresIn = data.expires_in || 3599;

      this.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

      this.logger.log('✅ توکن دیجی‌پی با موفقیت دریافت شد');

      return newToken;
    } catch (error) {
      this.logger.error('❌ خطا در دریافت توکن دیجی‌پی', error?.stack || error);

      throw new BadRequestException(
        error?.message || 'خطا در ارتباط با درگاه دیجی‌پی',
      );
    }
  }
}
