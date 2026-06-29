import { BadRequestException, Injectable } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';

@Injectable()
export class OtpService {
  constructor(private readonly redisService: RedisService) {}

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

    console.log(code);

    // ارسال پیامک (در صورت وجود)
    // await this.smsService.send(phone, `کد تایید شما: ${code}`);

    return {
      message: 'کد تایید ارسال شد',
      otp: code, // فقط برای تست (در production حذف شود)
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
