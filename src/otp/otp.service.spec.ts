import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { OtpService } from './otp.service';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

/** شبیهساز Redis با TTL واقعی (زمان صفر تا انقضا بر حسب ثانیه). */
class FakeRedis {
  private entries = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();
  now = 0;

  private live(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async exists(key: string) {
    await Promise.resolve();
    return this.live(key) ? 1 : 0;
  }

  async get(key: string) {
    await Promise.resolve();
    return this.live(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: boolean; EX?: number },
  ) {
    await Promise.resolve();
    if (options?.NX && this.live(key)) return null;
    this.entries.set(key, {
      value,
      expiresAt: options?.EX ? this.now + options.EX : null,
    });
    return 'OK';
  }

  async del(...keys: string[]) {
    await Promise.resolve();
    let removed = 0;
    for (const key of keys) {
      if (this.live(key)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async ttl(key: string) {
    await Promise.resolve();
    const entry = this.live(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, Math.ceil(entry.expiresAt - this.now));
  }

  async expire(key: string, seconds: number) {
    await Promise.resolve();
    const entry = this.live(key);
    if (!entry) return false;
    entry.expiresAt = this.now + seconds;
    return true;
  }

  async incr(key: string) {
    await Promise.resolve();
    const entry = this.live(key);
    const next = Number(entry?.value ?? '0') + 1;
    if (entry) entry.value = String(next);
    else this.entries.set(key, { value: '1', expiresAt: null });
    return next;
  }

  advance(seconds: number) {
    this.now += seconds;
  }

  storedKeys() {
    return [...this.entries.keys()];
  }
}

const PHONE = '09918690340';

function makeService() {
  const redis = new FakeRedis();
  const sms = { sendOtp: jest.fn().mockResolvedValue({ success: true }) };
  const otpService = new OtpService(
    { getClient: () => redis } as any,
    sms as any,
  );
  return { redis, sms, otpService };
}

describe('OtpService — انقضای کد == پنجرهی درخواست مجدد', () => {
  it('عمر کد و ممنوعیت ارسال مجدد از یک کلید/یک TTL گرفته میشود', async () => {
    const { redis, sms, otpService } = makeService();

    const result = await otpService.sendOtp(PHONE);

    expect(result.data.sent).toBe(true);
    expect(result.data.alreadySent).toBe(false);
    expect(result.data.expiresIn).toBe(120);
    expect(await redis.ttl(`otp:${PHONE}`)).toBe(120);
    expect(await redis.ttl(`otp:attempts:${PHONE}`)).toBe(120);
    // کلید cooldown جداگانه (۶۰ ثانیه) دیگر وجود ندارد
    expect(await redis.exists(`otp:cooldown:${PHONE}`)).toBe(0);
    expect(redis.storedKeys().sort()).toEqual([
      `otp:${PHONE}`,
      `otp:attempts:${PHONE}`,
    ]);
    expect(sms.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('ثابت fallback فرانت دقیقاً همان TTL بکاند است', () => {
    const front = readFileSync(
      resolve(__dirname, '../../../front/lib/otp-window.ts'),
      'utf8',
    );
    const [, seconds] = front.match(/OTP_TTL_SECONDS\s*=\s*(\d+)/) ?? [];
    expect(Number(seconds)).toBe(120);
  });

  it('درخواست مجدد زودهنگام: پیامک نمیرود، خطا نمیدهد و زمان دقیق باقیمانده را میگوید', async () => {
    const { redis, sms, otpService } = makeService();

    await otpService.sendOtp(PHONE);
    redis.advance(45);

    const result = await otpService.sendOtp(PHONE);

    expect(result.message).toBe('کد قبلا برای شما ارسال شده است');
    expect(result.data).toEqual({
      sent: false,
      alreadySent: true,
      expiresIn: 75,
    });
    expect(result.data.expiresIn).toBe(await redis.ttl(`otp:${PHONE}`));
    // همان کد قبلی هنوز معتبر است (قابل ورود در مرحلهی بعد)
    expect(await redis.get(`otp:${PHONE}`)).toHaveLength(5);
    expect(sms.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('لحظهای که کد منقضی میشود، ارسال مجدد هم آزاد میشود (بدون فاصله)', async () => {
    const { redis, sms, otpService } = makeService();

    await otpService.sendOtp(PHONE);
    redis.advance(119);
    const before = await otpService.sendOtp(PHONE);
    expect(before.data.alreadySent).toBe(true);
    expect(before.data.expiresIn).toBe(1);

    redis.advance(1);
    expect(await redis.ttl(`otp:${PHONE}`)).toBe(-2);
    const after = await otpService.sendOtp(PHONE);
    expect(after.data.sent).toBe(true);
    expect(after.data.expiresIn).toBe(120);
    expect(sms.sendOtp).toHaveBeenCalledTimes(2);
  });

  it('کلید cooldown قدیمی مانع ارسال کد جدید نمیشود', async () => {
    const { redis, sms, otpService } = makeService();

    await redis.set(`otp:cooldown:${PHONE}`, '1', { EX: 60 });
    const result = await otpService.sendOtp(PHONE);

    expect(result.data.sent).toBe(true);
    expect(await redis.exists(`otp:cooldown:${PHONE}`)).toBe(0);
    expect(sms.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('شکست پیامک (حتی success:false بیصدا) کدی ذخیره نمیکند و تلاش دوباره ممکن است', async () => {
    const { redis, sms, otpService } = makeService();
    sms.sendOtp.mockResolvedValueOnce({ success: false });

    await expect(otpService.sendOtp(PHONE)).rejects.toMatchObject({
      status: 502,
    });
    expect(await redis.get(`otp:${PHONE}`)).toBeNull();
    expect(await redis.get(`otp:attempts:${PHONE}`)).toBeNull();

    const retry = await otpService.sendOtp(PHONE);
    expect(retry.data.sent).toBe(true);
  });

  it('خطای پرتابشده از سرویس پیامک هم rollback میشود', async () => {
    const { redis, sms, otpService } = makeService();
    sms.sendOtp.mockRejectedValueOnce(new Error('gateway down'));

    await expect(otpService.sendOtp(PHONE)).rejects.toMatchObject({
      status: 502,
    });
    expect(await redis.get(`otp:${PHONE}`)).toBeNull();
  });

  it('کلید بدون TTL (دیتای قدیمی) اصلاح میشود و پیامک تازهای نمیرود', async () => {
    const { redis, sms, otpService } = makeService();
    await redis.set(`otp:${PHONE}`, '12345');

    const result = await otpService.sendOtp(PHONE);
    expect(result.data.alreadySent).toBe(true);
    expect(result.data.expiresIn).toBe(120);
    expect(await redis.ttl(`otp:${PHONE}`)).toBe(120);
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('دو درخواست همزمان فقط یک پیامک و یک کد معتبر ایجاد میکند', async () => {
    const { redis, sms, otpService } = makeService();

    const [first, second] = await Promise.all([
      otpService.sendOtp(PHONE),
      otpService.sendOtp(PHONE),
    ]);

    const sent = [first, second].filter(r => r.data.sent);
    expect(sent).toHaveLength(1);
    expect(sms.sendOtp).toHaveBeenCalledTimes(1);
    expect(await redis.get(`otp:${PHONE}`)).toHaveLength(5);
  });
});

describe('OtpService — تأیید کد', () => {
  it('consume:false کد و TTL آن را برای ثبتنام زنده نگه میدارد', async () => {
    const { redis, sms, otpService } = makeService();

    await otpService.sendOtp(PHONE);
    const code = sms.sendOtp.mock.calls[0][1] as string;
    redis.advance(30);

    await expect(
      otpService.verifyOtp(PHONE, code, { consume: false }),
    ).resolves.toBe(true);
    expect(await redis.get(`otp:${PHONE}`)).toBe(code);
    expect(await redis.ttl(`otp:${PHONE}`)).toBe(90);

    // مرحلهی ثبتنام همان کد را مصرف میکند
    await expect(otpService.verifyOtp(PHONE, code)).resolves.toBe(true);
    expect(await redis.get(`otp:${PHONE}`)).toBeNull();
  });

  it('تأیید موفق کد را مصرف میکند؛ همان لحظه ارسال مجدد آزاد است', async () => {
    const { sms, otpService } = makeService();
    await otpService.sendOtp(PHONE);
    const code = sms.sendOtp.mock.calls[0][1] as string;

    await otpService.verifyOtp(PHONE, code);
    const again = await otpService.sendOtp(PHONE);
    expect(again.data.sent).toBe(true);
  });

  it('کد اشتباه شمارش میشود و TTL تلاشها از کد جلوتر نمیرود', async () => {
    const { redis, sms, otpService } = makeService();
    await otpService.sendOtp(PHONE);
    const code = sms.sendOtp.mock.calls[0][1] as string;
    redis.advance(20);

    await expect(otpService.verifyOtp(PHONE, '00000')).rejects.toMatchObject({
      message: 'کد وارد شده اشتباه است',
    });
    expect(await redis.get(`otp:attempts:${PHONE}`)).toBe('1');
    expect(await redis.ttl(`otp:attempts:${PHONE}`)).toBe(
      await redis.ttl(`otp:${PHONE}`),
    );

    await expect(
      otpService.verifyOtp(PHONE, code, { consume: false }),
    ).resolves.toBe(true);
  });

  it('بعد از ۵ تلاش ناموفق کد باطل و ارسال مجدد آزاد میشود', async () => {
    const { sms, otpService } = makeService();
    await otpService.sendOtp(PHONE);

    for (let i = 0; i < 4; i++) {
      await expect(otpService.verifyOtp(PHONE, '00000')).rejects.toMatchObject({
        message: 'کد وارد شده اشتباه است',
      });
    }
    await expect(otpService.verifyOtp(PHONE, '00000')).rejects.toMatchObject({
      status: 429,
    });

    const result = await otpService.sendOtp(PHONE);
    expect(result.data.sent).toBe(true);
    expect(sms.sendOtp).toHaveBeenCalledTimes(2);
  });

  it('کد منقضیشده پیام «کد منقضی شده است» میدهد', async () => {
    const { redis, otpService } = makeService();
    await otpService.sendOtp(PHONE);
    redis.advance(120);

    await expect(otpService.verifyOtp(PHONE, '12345')).rejects.toMatchObject({
      message: 'کد منقضی شده است',
    });
  });
});
