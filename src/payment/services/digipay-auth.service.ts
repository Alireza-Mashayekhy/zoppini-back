// src/payment/services/digipay-auth.service.ts
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class DigipayAuthService {
  private readonly logger = new Logger(DigipayAuthService.name);
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {}

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

    try {
      const url = `${this.getBaseUrl()}/oauth/token`;
      const credentials = Buffer.from(
        `${this.getClientId()}:${this.getClientSecret()}`,
      ).toString('base64');

      const payload = new URLSearchParams();
      payload.append('grant_type', 'password');
      payload.append('username', this.getUsername());
      payload.append('password', this.getPassword());

      const response = await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${credentials}`,
          },
        }),
      );

      const data = response.data;
      const newToken = data.access_token;
      if (!newToken) {
        throw new Error('توکن در پاسخ دیجی‌پی موجود نیست');
      }

      this.accessToken = newToken;
      const expiresIn = data.expires_in || 3599; // حدوداً ۱ ساعت
      this.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

      this.logger.log('✅ توکن دیجی‌پی با موفقیت دریافت شد');
      return this.accessToken || '';
    } catch (error) {
      this.logger.error('❌ خطا در دریافت توکن دیجی‌پی', error.message);
      throw new BadRequestException('خطا در ارتباط با درگاه دیجی‌پی');
    }
  }
}
