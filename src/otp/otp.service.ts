import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';
import { SmsService } from '../sms/sms.service';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly smsService: SmsService,
  ) {}

  async sendOtp(phone: string) {
    const redis = this.redisService.getClient();

    // بررسی وجود OTP قبلی
    const existingOtp = await redis.get(`otp:${phone}`);
    if (existingOtp) {
      // محاسبه زمان باقی‌مانده برای نمایش به کاربر
      throw new BadRequestException('کد قبلا برای شما ارسال شده است');
    }

    // تولید کد جدید
    const code = Math.floor(10000 + Math.random() * 90000).toString();

    // ذخیره در Redis با انقضای ۱۲۰ ثانیه
    await redis.set(`otp:${phone}`, code, {
      EX: 120,
    });

    // لاگ کد در محیط غیر生产 برای دیباگ
    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(`OTP for ${phone}: ${code}`);
    }

    // ارسال پیامک
    await this.smsService.sendOtp(phone, code);

    return {
      message: 'کد تایید ارسال شد',
    };
  }

  async verifyOtp(phone: string, code: string) {
    const redis = this.redisService.getClient();

    const storedCode = await redis.get(`otp:${phone}`);

    if (!storedCode) {
      throw new BadRequestException('کد منقضی شده است');
    }

    if (storedCode !== code) {
      throw new BadRequestException('کد وار شده اشتباه است');
    }

    await redis.del(`otp:${phone}`);

    return true;
  }
}
