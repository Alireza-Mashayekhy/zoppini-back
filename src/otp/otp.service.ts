import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import {
  maskMobile,
  serializeError,
  structuredLog,
} from 'src/common/logging/structured-logger';
import { toLatinDigits } from 'src/common/utils/phone.util';

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
   * یا تا تکمیل موفق فرایند ورود/ثبت‌نام حفظ شود؛ در این حالت کلید انقضا هم
   * دست‌نخورده می‌ماند.
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

  private async runRedis<T>(
    stage: string,
    phone: string,
    fn: (redis: ReturnType<RedisService['getClient']>) => Promise<T>,
  ): Promise<T> {
    try {
      const redis = this.redisService.getClient();
      if (!redis) {
        throw new Error('Redis client is not initialized');
      }
      return await fn(redis);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(
        structuredLog('auth.otp.redis_error', {
          stage,
          phone: maskMobile(phone),
          error: serializeError(error),
          timestamp: new Date().toISOString(),
        }),
      );

      throw new ServiceUnavailableException(
        'سرویس اعتبارسنجی کد موقتاً در دسترس نیست؛ لطفاً چند لحظه دیگر تلاش کنید',
      );
    }
  }

  async sendOtp(phone: string): Promise<SendOtpResult> {
    const otpKey = `otp:${phone}`;
    const attemptsKey = `otp:attempts:${phone}`;
    const legacyCooldownKey = `otp:cooldown:${phone}`;

    const reservation = await this.runRedis(
      'send_otp_reserve',
      phone,
      async redis => {
        // کد فعال یعنی هنوز نباید پیامک جدیدی برود. به جای خطای «صبر کنید»،
        // زمان دقیق باقی‌مانده را برمیگردانیم تا فرانت همان کد قبلی را بگیرد.
        const existingTtl = await redis.ttl(otpKey);

        if (existingTtl > 0) {
          return { alreadySentTtl: existingTtl, code: null as string | null };
        }

        // حالت دفاعی: کلید بدون TTL (نسخههای قدیمی/دیتای دستی) — TTL را اصلاح میکنیم
        if (existingTtl === -1) {
          await redis.expire(otpKey, this.OTP_TTL);
          return { alreadySentTtl: this.OTP_TTL, code: null as string | null };
        }

        const generatedCode = randomInt(10000, 100000).toString();

        // رزرو اتمیک: اگر دو درخواست همزمان بیایند فقط یکی کد ذخیره میکند و
        // فقط همان یکی پیامک میفرستد (کد داخل پیامک حتماً همان کد ذخیرهشده است).
        const reserved = await redis.set(otpKey, generatedCode, {
          NX: true,
          EX: this.OTP_TTL,
        });

        if (!reserved) {
          const ttl = await redis.ttl(otpKey);
          return {
            alreadySentTtl: ttl > 0 ? ttl : this.OTP_TTL,
            code: null as string | null,
          };
        }

        // تلاشها هم دقیقاً تا لحظهای که کد منقضی میشود اعتبار دارند
        const reservedTtl = await redis.ttl(otpKey);
        await redis.set(attemptsKey, '0', {
          EX: reservedTtl > 0 ? reservedTtl : this.OTP_TTL,
        });

        return { alreadySentTtl: null as number | null, code: generatedCode };
      },
    );

    if (reservation.alreadySentTtl !== null || !reservation.code) {
      return this.alreadySentResult(reservation.alreadySentTtl ?? this.OTP_TTL);
    }

    const code = reservation.code;

    try {
      const result = await this.smsService.sendOtp(phone, code);

      // SmsService خطاها را قورت میدهد و { success: false } برمیگرداند؛
      // بدون این بررسی، کدی که هرگز پیامک نشده معتبر ذخیره میماند.
      if (result?.success === false) {
        throw new Error('SMS gateway rejected the OTP request');
      }
    } catch (error) {
      // فقط رزرو خودمان را پاک میکنیم (ممکن است درخواست دیگری جایگزین شده باشد)
      await this.runRedis('send_otp_rollback', phone, async redis => {
        const current = await redis.get(otpKey);
        if (current === code) {
          await redis.del(otpKey);
          await redis.del(attemptsKey);
        }
      }).catch(() => undefined);

      this.logger.error(
        structuredLog('auth.otp.sms_failed', {
          stage: 'sms_send',
          phone: maskMobile(phone),
          error: serializeError(error),
          timestamp: new Date().toISOString(),
        }),
      );

      throw new HttpException(
        'ارسال پیامک ناموفق بود؛ لطفاً دوباره تلاش کنید',
        HttpStatus.BAD_GATEWAY,
      );
    }

    // نسخهی قبلی سرویس یک کلید cooldown جداگانه (۶۰ ثانیه) میساخت. پاکش
    // میکنیم تا بعد از مصرف کد، مانع ارسال بعدی نشود.
    await this.runRedis('send_otp_cleanup_legacy', phone, redis =>
      redis.del(legacyCooldownKey),
    ).catch(() => undefined);

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
    const normalizedCode = toLatinDigits(String(code ?? '')).trim();

    const otpKey = `otp:${phone}`;
    const attemptsKey = `otp:attempts:${phone}`;

    await this.runRedis('verify_otp', phone, async redis => {
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

      if (storedCode !== normalizedCode) {
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
    });

    // موفق — در حالت `consume: false` کد برای تکمیل فرایند یا مرحله‌ی ثبت‌نام زنده می‌ماند
    if (consume) {
      const consumed = await this.consumeOtp(phone);
      if (!consumed) {
        throw new BadRequestException('کد منقضی شده است');
      }
    }

    return true;
  }

  /**
   * کد معتبر تأییدشده را به‌صورت اتمیک مصرف می‌کند (غیرقابل استفاده‌ی مجدد).
   * خروجی `true` یعنی همین فراخوانی کلید را حذف کرده و `false` یعنی کد پیش‌تر
   * مصرف یا منقضی شده بود.
   */
  async consumeOtp(phone: string): Promise<boolean> {
    return this.runRedis('consume_otp', phone, async redis => {
      const deleted = await redis.del(`otp:${phone}`);
      await redis.del(`otp:attempts:${phone}`);
      return Number(deleted) > 0;
    });
  }

  /** ثانیههای باقی‌مانده تا انقضای کد فعال (۰ اگر کدی نیست). */
  async getRemainingTtl(phone: string): Promise<number> {
    const ttl = await this.runRedis('get_remaining_ttl', phone, redis =>
      redis.ttl(`otp:${phone}`),
    );
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
