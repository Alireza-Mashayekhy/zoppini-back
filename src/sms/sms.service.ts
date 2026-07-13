// src/sms/sms.service.ts
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly apiKey: string;
  private readonly adminPhone: string;

  constructor(private readonly httpService: HttpService) {
    this.apiKey = process.env.GHASEDAK_API_KEY || '';
    this.adminPhone = process.env.ADMIN_PHONE || '';
  }

  // متد اصلی ارسال پیامک (دقیقاً مشابه تابع send_ghasedak_verify در PHP)
  async sendGhasedakVerify(
    receptor: string,
    template: string,
    param1: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      // نرمال‌سازی شماره (مشابه normalize_iran_phone)
      const normalizedPhone = this.normalizePhone(receptor);

      // ساخت post_fields به فرمت x-www-form-urlencoded
      const postFields = new URLSearchParams({
        type: '1',
        receptor: normalizedPhone,
        template: template,
        param1: param1,
      });

      this.logger.log(`📤 ارسال پیامک به ${receptor} با قالب ${template}`);

      const response = await firstValueFrom(
        this.httpService.post(
          'https://api.ghasedaksms.com/v2/send/verify',
          postFields.toString(),
          {
            headers: {
              apikey: this.apiKey,
              'content-type': 'application/x-www-form-urlencoded',
            },
            timeout: 30000,
          },
        ),
      );

      this.logger.log(`✅ پیامک به ${receptor} با موفقیت ارسال شد`);
      return {
        success: true,
        message: response.data?.message || 'پیامک با موفقیت ارسال شد',
      };
    } catch (error) {
      this.logger.error(`❌ خطا در ارسال پیامک به ${receptor}:`, error.message);
      if (error.response) {
        this.logger.error('📄 پاسخ سرور:', error.response.data);
        this.logger.error('📊 وضعیت:', error.response.status);
      }
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * نرمال‌سازی شماره تلفن (مشابه تابع normalize_iran_phone در PHP)
   */
  private normalizePhone(phone: string): string {
    // حذف همه کاراکترهای غیرعددی
    let cleaned = phone.replace(/\D/g, '');

    // اگر با 98 شروع شده بود، تبدیل به 0
    if (cleaned.startsWith('98')) {
      cleaned = '0' + cleaned.substring(2);
    }

    // اگر با 9 شروع شده بود، 0 اضافه کن
    if (cleaned.startsWith('9')) {
      cleaned = '0' + cleaned;
    }

    return cleaned;
  }

  // ============= متدهای کاربردی (مشابه کد PHP) =============

  // ۱. ارسال کد تایید (OTP)
  async sendOtp(phone: string, code: string): Promise<{ success: boolean }> {
    const result = await this.sendGhasedakVerify(phone, 'OtpTemplate', code);
    return { success: result.success };
  }

  // ۲. پیامک ثبت سفارش به مشتری (CustomerOrder)
  async sendOrderConfirmationToCustomer(
    phone: string,
    orderNumber: string,
    customerName: string,
  ): Promise<{ success: boolean }> {
    const result = await this.sendGhasedakVerify(
      phone,
      'CustomerOrder',
      customerName,
    );
    return { success: result.success };
  }

  // ۳. پیامک ثبت سفارش به ادمین (AdminOrder)
  async sendOrderNotificationToAdmin(
    orderNumber: string,
    customerName: string,
    customerPhone: string,
    totalPrice: number,
  ): Promise<{ success: boolean }> {
    const result = await this.sendGhasedakVerify(
      this.adminPhone,
      'AdminOrder',
      orderNumber,
    );
    return { success: result.success };
  }

  // ۴. ارسال پیامک یادآوری سفارش پرداخت‌نشده (UnpaidOrder)
  async sendUnpaidOrderReminder(
    phone: string,
    orderNumber: string,
    customerName: string,
  ): Promise<{ success: boolean }> {
    const result = await this.sendGhasedakVerify(
      phone,
      'UnpaidOrder',
      customerName,
    );
    return { success: result.success };
  }

  // ۵. ارسال پیامک با قالب دلخواه
  async sendCustomVerify(
    receptor: string,
    template: string,
    param1: string,
  ): Promise<{ success: boolean }> {
    const result = await this.sendGhasedakVerify(receptor, template, param1);
    return { success: result.success };
  }
}
