import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomInt } from 'crypto';

import { RedisService } from '../redis/redis.service';
import { SmsService } from '../sms/sms.service';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  private readonly OTP_TTL = 120; // 2 minutes
  private readonly MAX_VERIFY_ATTEMPTS = 5;
  private readonly SEND_COOLDOWN = 60; // 60 seconds

  constructor(
    private readonly redisService: RedisService,
    private readonly smsService: SmsService,
  ) {}

  async sendOtp(phone: string) {
    const redis = this.redisService.getClient();

    const otpKey = `otp:${phone}`;
    const attemptsKey = `otp:attempts:${phone}`;
    const cooldownKey = `otp:cooldown:${phone}`;

    // جلوگیری از ارسال مجدد در 60 ثانیه
    const cooldownExists = await redis.exists(cooldownKey);

    if (cooldownExists) {
      throw new HttpException(
        'لطفاً قبل از درخواست مجدد کمی صبر کنید',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // اگر OTP قبلی هنوز معتبر است
    const existingOtp = await redis.exists(otpKey);

    if (existingOtp) {
      throw new HttpException(
        'کد قبلی هنوز معتبر است',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // تولید OTP امن
    const code = randomInt(10000, 100000).toString();

    // ذخیره OTP
    await redis.set(otpKey, code, {
      EX: this.OTP_TTL,
    });

    // reset attempts
    await redis.set(attemptsKey, '0', {
      EX: this.OTP_TTL,
    });

    // cooldown
    await redis.set(cooldownKey, '1', {
      EX: this.SEND_COOLDOWN,
    });

    // فقط development
    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(`OTP for ${phone}: ${code}`);
    }

    try {
      await this.smsService.sendOtp(phone, code);
    } catch (error) {
      // rollback state اگر SMS ارسال نشد
      await redis.del(otpKey);
      await redis.del(attemptsKey);
      await redis.del(cooldownKey);

      throw error;
    }

    return {
      message: 'کد تایید ارسال شد',
    };
  }

  async verifyOtp(phone: string, code: string) {
    const redis = this.redisService.getClient();

    const otpKey = `otp:${phone}`;
    const attemptsKey = `otp:attempts:${phone}`;

    const storedCode = await redis.get(otpKey);

    if (!storedCode) {
      throw new BadRequestException('کد منقضی شده است');
    }

    const attempts = Number((await redis.get(attemptsKey)) ?? '0');

    if (attempts >= this.MAX_VERIFY_ATTEMPTS) {
      await redis.del(otpKey);
      await redis.del(attemptsKey);

      throw new HttpException(
        'تعداد تلاش‌های مجاز تمام شده است',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (storedCode !== code) {
      const newAttempts = await redis.incr(attemptsKey);

      if (newAttempts === 1) {
        await redis.expire(attemptsKey, this.OTP_TTL);
      }

      if (newAttempts >= this.MAX_VERIFY_ATTEMPTS) {
        await redis.del(otpKey);
        await redis.del(attemptsKey);

        throw new HttpException(
          'تعداد تلاش‌های مجاز تمام شده است',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new BadRequestException('کد وارد شده اشتباه است');
    }

    // موفق
    await redis.del(otpKey);
    await redis.del(attemptsKey);

    return true;
  }
}
