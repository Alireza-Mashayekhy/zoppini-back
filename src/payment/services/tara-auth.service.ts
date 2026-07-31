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

    this.logger.log('========== TARA AUTH ==========');
    this.logger.log(`URL: ${url}`);
    this.logger.log(`Username: ${username}`);
    this.logger.log(`Password length: ${password.length}`);
    this.logger.log(
      `Payload: ${JSON.stringify({
        username,
        password: '***',
      })}`,
    );
    this.logger.log('================================');

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

      this.logger.log(
        `Tara auth response: ${JSON.stringify(response.data, null, 2)}`,
      );

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

      const newToken = data?.accessToken || data?.access_token || data?.token;

      if (!newToken) {
        throw new Error('توکن در پاسخ تارا موجود نیست');
      }

      this.accessToken = String(newToken);

      /*
       * پشتیبانی از چند نوع expireTime
       */
      const expireTime = data?.expireTime;

      if (expireTime) {
        const expireDate = new Date(expireTime);

        if (!Number.isNaN(expireDate.getTime())) {
          this.tokenExpiresAt = expireDate;
        } else {
          this.tokenExpiresAt = new Date(Date.now() + 3600 * 1000);
        }
      } else if (data?.expiresIn) {
        this.tokenExpiresAt = new Date(
          Date.now() + Number(data.expiresIn) * 1000,
        );
      } else if (data?.expires_in) {
        this.tokenExpiresAt = new Date(
          Date.now() + Number(data.expires_in) * 1000,
        );
      } else {
        // پیش‌فرض 1 ساعت
        this.tokenExpiresAt = new Date(Date.now() + 3600 * 1000);
      }

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

  clearToken(): void {
    this.accessToken = null;
    this.tokenExpiresAt = null;
  }
}
