import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class ZarinpalAuthService {
  private readonly logger = new Logger(ZarinpalAuthService.name);
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {}

  private getClientId(): number {
    return Number(this.configService.get<string>('ZARINPAL_CLIENT_ID'));
  }

  private getClientSecret(): string {
    return this.configService.get<string>('ZARINPAL_CLIENT_SECRET')!;
  }

  private getOAuthBaseUrl(): string {
    return this.configService.get<string>('ZARINPAL_OAUTH_URL')!;
  }

  async getAccessToken(): Promise<string> {
    // اگر توکن معتبر وجود دارد، برگردان
    if (
      this.accessToken &&
      this.tokenExpiresAt &&
      this.tokenExpiresAt > new Date()
    ) {
      return this.accessToken;
    }

    // دریافت توکن جدید با استفاده از Client Credentials
    try {
      const url = `${this.getOAuthBaseUrl()}/token`;
      const payload = {
        grant_type: 'client_credentials',
        client_id: this.getClientId(),
        client_secret: this.getClientSecret(),
        scope: '*',
      };

      const response = await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const data = response.data;
      const newToken = data.access_token;
      if (!newToken) {
        throw new Error('توکن در پاسخ زرین‌پال موجود نیست');
      }
      this.accessToken = newToken;
      const expiresIn = data.expires_in || 1296000; // ۱۵ روز
      this.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

      this.logger.log('✅ توکن زرین‌پال با موفقیت دریافت شد');
      return this.accessToken || '';
    } catch (error) {
      this.logger.error('❌ خطا در دریافت توکن زرین‌پال', error.message);
      throw new BadRequestException('خطا در ارتباط با درگاه زرین‌پال');
    }
  }

  // برای کاربران (در صورت نیاز به احراز هویت با شماره موبایل)
  async initializeUserAuth(username: string, channel: 'ussd' | 'sms' = 'sms') {
    const url = `${this.getOAuthBaseUrl()}/initialize`;
    const payload = { username, channel };

    try {
      const response = await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      return response.data;
    } catch (error) {
      this.logger.error('❌ خطا در شروع احراز هویت کاربر', error.message);
      throw new BadRequestException('خطا در شروع احراز هویت');
    }
  }

  async verifyUser(username: string, password: string) {
    const url = `${this.getOAuthBaseUrl()}/token`;
    const payload = {
      grant_type: 'password',
      client_id: this.getClientId(),
      client_secret: this.getClientSecret(),
      username,
      password,
      scope: '*',
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      return response.data;
    } catch (error) {
      this.logger.error('❌ خطا در تأیید رمز کاربر', error.message);
      throw new BadRequestException('خطا در تأیید رمز');
    }
  }
}
