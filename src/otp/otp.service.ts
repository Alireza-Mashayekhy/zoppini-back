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

export interface SendOtpResult {
  message: string;
  data: {
    /** آیا پیامک جدیدی ارسال شد؟ */
    sent: boolean;
    /** کد قبلی هنوز معتبر بود و پیامکی ارسال نشد */
    alreadySent: boolean;
    /** ثانیه‌های باقی‌مانده تا انقضای کد == ثانیه‌های باقی‌مانده تا امکان ارسال مجدد */
    expiresIn: number;
  };
}

export interface VerifyOtpOptions {
  /**
   * بعد از تطابق کد، آن را مصرف کن (پاک کن).
   * اگر `false` باشد کد معتبر باقی میماند تا مثلاً همان کد در `/auth/sign-up`
   * دوباره بررسی شود؛ در این حالت کلید انقضا هم دستنخورده میماند.
   */
  consume?: boolean;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  /**
   * عمر کد و پنجره‌ی «درخواست مجدد» یکی است: هر دو از TTL همین یک کلید
   * (`otp:<phone>`) گرفته میشوند. تا وقتی کلید هست، کد معتبر است و ارسال مجدد
   * ممنوع؛ لحظهای که کلید منقضی/حذف شود، هم کد باطل است و هم ارسال مجدد آزاد.
   * بنابراین اختلافی بین «زمان انقضای کد قبلی» و «زمان درخواست مجدد» وجود ندارد.
   */
  private readonly OTP_TTL = 120; // seconds
  private readonly MAX_VERIFY_ATTEMPTS = 5;

  constructor(
    private readonly redisService: RedisService,
    private readonly smsService: SmsService,
  ) {}

  async sendOtp(phone: string): Promise<SendOtpResult> {
    const redis = this.redisService.getClient();

    const otpKey = `otp:${phone}`;
    const attemptsKey = `otp:attempts:${phone}`;
    const legacyCooldownKey = `otp:cooldown:${phone}`;

    // کد فعال یعنی هنوز نباید پیامک جدیدی برود. به جای خطای «صبر کنید»،
    // زمان دقیق باقی‌مانده را برمیگردانیم تا فرانت همان کد قبلی را بگیرد.
    const existingTtl = await redis.ttl(otpKey);

    if (existingTtl > 0) {
      return this.alreadySentResult(existingTtl);
    }

    // حالت دفاعی: کلید بدون TTL (نسخههای قدیمی/دیتای دستی) — TTL را اصلاح میکنیم
    if (existingTtl === -1) {
      await redis.expire(otpKey, this.OTP_TTL);
      return this.alreadySentResult(this.OTP_TTL);
    }

    const code = randomInt(10000, 100000).toString();

    // رزرو اتمیک: اگر دو درخواست همزمان بیایند فقط یکی کد ذخیره میکند و
    // فقط همان یکی پیامک میفرستد (کد داخل پیامک حتماً همان کد ذخیرهشده است).
    const reserved = await redis.set(otpKey, code, {
      NX: true,
      EX: this.OTP_TTL,
    });

    if (!reserved) {
      const ttl = await redis.ttl(otpKey);
      return this.alreadySentResult(ttl > 0 ? ttl : this.OTP_TTL);
    }

    // تلاشها هم دقیقاً تا لحظهای که کد منقضی میشود اعتبار دارند
    const reservedTtl = await redis.ttl(otpKey);
    await redis.set(attemptsKey, '0', {
      EX: reservedTtl > 0 ? reservedTtl : this.OTP_TTL,
    });

    try {
      const result = await this.smsService.sendOtp(phone, code);

      // SmsService خطاها را قورت میدهد و { success: false } برمیگرداند؛
      // بدون این بررسی، کدی که هرگز پیامک نشده معتبر ذخیره میماند.
      if (result?.success === false) {
        throw new Error('SMS gateway rejected the OTP request');
      }
    } catch (error) {
      // فقط رزرو خودمان را پاک میکنیم (ممکن است درخواست دیگری جایگزین شده باشد)
      const current = await redis.get(otpKey);
      if (current === code) {
        await redis.del(otpKey);
        await redis.del(attemptsKey);
      }
      this.logger.error(`ارسال کد به ${phone} ناموفق بود`, error);

      throw new HttpException(
        'ارسال پیامک ناموفق بود؛ لطفاً دوباره تلاش کنید',
        HttpStatus.BAD_GATEWAY,
      );
    }

    // نسخهی قبلی سرویس یک کلید cooldown جداگانه (۶۰ ثانیه) میساخت. پاکش
    // میکنیم تا بعد از مصرف کد، مانع ارسال بعدی نشود.
    await redis.del(legacyCooldownKey);

    // فقط development
    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(`OTP for ${phone}: ${code}`);
    }

    return {
      message: 'کد تایید ارسال شد',
      data: {
        sent: true,
        alreadySent: false,
        expiresIn: this.OTP_TTL,
      },
    };
  }

  async verifyOtp(phone: string, code: string, options: VerifyOtpOptions = {}) {
    const { consume = true } = options;
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

      // تلاشها نباید دیرتر از خود کد منقضی شوند
      const otpTtl = await redis.ttl(otpKey);
      await redis.expire(attemptsKey, otpTtl > 0 ? otpTtl : this.OTP_TTL);

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

    // موفق — در حالت `consume: false` کد برای مرحلهی بعد (ثبتنام) زنده میماند
    if (consume) {
      await this.consumeOtp(phone);
    }

    return true;
  }

  /** کد معتبر تأییدشده را یکبار مصرف میکند (غیرقابل استفادهی مجدد). */
  async consumeOtp(phone: string): Promise<void> {
    const redis = this.redisService.getClient();
    await redis.del(`otp:${phone}`);
    await redis.del(`otp:attempts:${phone}`);
  }

  /** ثانیههای باقی‌مانده تا انقضای کد فعال (۰ اگر کدی نیست). */
  async getRemainingTtl(phone: string): Promise<number> {
    const ttl = await this.redisService.getClient().ttl(`otp:${phone}`);
    return ttl > 0 ? ttl : 0;
  }

  private alreadySentResult(expiresIn: number): SendOtpResult {
    return {
      message: 'کد قبلا برای شما ارسال شده است',
      data: {
        sent: false,
        alreadySent: true,
        expiresIn,
      },
    };
  }
}
