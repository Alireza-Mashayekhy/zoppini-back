// src/club/club.service.ts
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class ClubService {
  private readonly logger = new Logger(ClubService.name);
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  constructor(private readonly httpService: HttpService) {}

  private async getAccessToken(): Promise<string> {
    // اگر توکن معتبر است و منقضی نشده، آن را برگردان (با اطمینان از اینکه null نیست)
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken; // اینجا accessToken حتماً string است
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          'https://zoppiniclub.dayaclub.com/api/token',
          new URLSearchParams({
            grant_type: 'password',
            username: 'apiuser-site@dayaclub.com',
            password: 'XSW@3EDC',
          }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        ),
      );

      const token = response.data?.access_token;
      if (!token || typeof token !== 'string') {
        throw new Error('توکن نامعتبر یا ناقص از سرور باشگاه دریافت شد');
      }

      this.accessToken = token;
      this.tokenExpiry = new Date(Date.now() + 3600 * 1000);
      this.logger.log('✅ توکن باشگاه مشتریان دریافت شد');
      return this.accessToken; // اینجا حتماً string است
    } catch (error) {
      this.logger.error('❌ خطا در دریافت توکن باشگاه:', error.message);
      throw new Error('خطا در ارتباط با باشگاه مشتریان');
    }
  }

  async registerCustomer(data: {
    firstName: string;
    lastName: string;
    customerCode: string;
    email?: string;
    birthDate?: string;
  }): Promise<void> {
    try {
      const token = await this.getAccessToken(); // همیشه string

      const payload = {
        FirstName: data.firstName,
        LastName: data.lastName,
        CustomerCode: data.customerCode,
        Email: data.email || '',
        BirthDate: data.birthDate || null,
      };

      await firstValueFrom(
        this.httpService.post(
          'https://zoppiniclub.dayaclub.com/api/v1/customers',
          payload,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          },
        ),
      );

      this.logger.log(
        `✅ کاربر ${data.firstName} ${data.lastName} در باشگاه ثبت شد`,
      );
    } catch (error) {
      this.logger.error('❌ خطا در ثبت مشتری در باشگاه:', error.message);
      // خطا را پرتاب نمی‌کنیم تا ثبت‌نام اصلی انجام شود
    }
  }
}
