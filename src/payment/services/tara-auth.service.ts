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
    private configService: ConfigService,
    private httpService: HttpService,
  ) {}

  private getBaseUrl(): string {
    return this.configService.get<string>('TARA_API_URL')!;
  }

  private getUsername(): string {
    return this.configService.get<string>('TARA_USERNAME')!;
  }

  private getPassword(): string {
    return this.configService.get<string>('TARA_PASSWORD')!;
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
      const url = `${this.getBaseUrl()}/api/v2/authenticate`;
      const payload = {
        username: this.getUsername(),
        password: this.getPassword(),
      };

      const response = await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const data = response.data;
      const newToken = data.accessToken;
      if (!newToken) {
        throw new Error('توکن در پاسخ تارا موجود نیست');
      }

      this.accessToken = newToken;
      // زمان انقضا را از پاسخ بگیرید (اگر موجود است)
      const expireTime = data.expireTime;
      if (expireTime) {
        this.tokenExpiresAt = new Date(expireTime);
      } else {
        // پیش‌فرض ۱ ساعت
        this.tokenExpiresAt = new Date(Date.now() + 3600 * 1000);
      }

      this.logger.log('✅ توکن تارا با موفقیت دریافت شد');
      return this.accessToken || '';
    } catch (error) {
      this.logger.error('❌ خطا در دریافت توکن تارا', error.message);
      throw new BadRequestException('خطا در ارتباط با درگاه تارا');
    }
  }
}
