import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { CartsService } from 'src/cart/cart.service';
import { ClubService } from 'src/club/club.service';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { ResponseInterceptor } from 'src/common/interceptors/response.interceptor';
import { OtpService } from 'src/otp/otp.service';
import { RahkaranService } from 'src/rahkaran/rahkaran.service';
import { RedisService } from 'src/redis/redis.service';
import { SmsService } from 'src/sms/sms.service';
import { UsersService } from 'src/users/users.service';
import request from 'supertest';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/** Redis در حافظه با TTL قابل جلو بردن، برای تست جریان واقعی OTP. */
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

  async ttl(key: string) {
    await Promise.resolve();
    const entry = this.live(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, Math.ceil(entry.expiresAt - this.now));
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
}

const PHONE = '09918690340';
const OTHER_PHONE = '09121234567';

/**
 * رگرسیون چهار باگ گزارششدهی ورود، روی همان لایهای که مرورگر صدا میزند
 * (ValidationPipe + ResponseInterceptor + کوکیها)، نه فقط روی سرویسها.
 */
describe('Auth HTTP — جریان کامل ورود/ثبتنام', () => {
  let app: NestExpressApplication;
  let redis: FakeRedis;
  const smsCodes: Record<string, string> = {};
  const users = new Map<string, any>();

  beforeAll(async () => {
    redis = new FakeRedis();

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        OtpService,
        AuthGuard,
        { provide: RedisService, useValue: { getClient: () => redis } },
        {
          provide: SmsService,
          useValue: {
            sendOtp: (phone: string, code: string) => {
              smsCodes[phone] = code;
              return Promise.resolve({ success: true });
            },
          },
        },
        {
          provide: UsersService,
          useValue: {
            findWithPhone: (phone: string) =>
              Promise.resolve(users.get(phone) ?? null),
            findWithEmail: () => Promise.resolve(null),
            findOne: () => Promise.resolve(null),
            create: (dto: any) => {
              const user = { id: users.size + 1, ...dto };
              users.set(dto.phone, user);
              return Promise.resolve(user);
            },
            updateUser: () => Promise.resolve(undefined),
          },
        },
        {
          provide: JwtService,
          useValue: {
            signAsync: () => Promise.resolve('jwt-token'),
            verifyAsync: () => Promise.resolve({ sub: 1 }),
          },
        },
        {
          provide: CartsService,
          useValue: { mergeGuestCart: () => Promise.resolve() },
        },
        {
          provide: ClubService,
          useValue: { registerCustomer: () => Promise.resolve({}) },
        },
        {
          provide: RahkaranService,
          useValue: { createLoyaltyMemberForUser: () => Promise.resolve() },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const server = () => app.getHttpServer();

  it('ارسال کد: ۲۰۰/۲۰۱ با expiresIn مشخص و بدون کلید cooldown جداگانه', async () => {
    const res = await request(server())
      .post('/api/auth/send-otp')
      .send({ phone: PHONE })
      .expect(201);

    expect(res.body.data).toEqual({
      sent: true,
      alreadySent: false,
      expiresIn: 120,
    });
    expect(await redis.ttl(`otp:${PHONE}`)).toBe(120);
    expect(smsCodes[PHONE]).toHaveLength(5);
  });

  it('درخواست دوباره شماره: «صبر کنید» نمیدهد، پیامک نمیرود، کد قبلی زنده میماند', async () => {
    const before = smsCodes[PHONE];
    const res = await request(server())
      .post('/api/auth/send-otp')
      .send({ phone: PHONE })
      .expect(201);

    expect(res.body.message).toBe('کد قبلا برای شما ارسال شده است');
    expect(res.body.data.alreadySent).toBe(true);
    expect(res.body.data.sent).toBe(false);
    expect(res.body.data.expiresIn).toBe(await redis.ttl(`otp:${PHONE}`));
    expect(await redis.get(`otp:${PHONE}`)).toBe(before);
    expect(smsCodes[PHONE]).toBe(before);
  });

  it('زمان انقضای کد دقیقاً همان زمان مجاز ارسال مجدد است', async () => {
    // ۱۱۹ ثانیه بعد: کد هنوز معتبر است و ارسال مجدد ممنوع
    redis.advance(119);
    const beforeExpiry = await request(server())
      .post('/api/auth/send-otp')
      .send({ phone: PHONE })
      .expect(201);

    expect(beforeExpiry.body.data.alreadySent).toBe(true);
    expect(beforeExpiry.body.data.expiresIn).toBe(1);
    expect(beforeExpiry.body.data.expiresIn).toBe(
      await redis.ttl(`otp:${PHONE}`),
    );

    // همان لحظهای که کد منقضی میشود، ارسال مجدد هم آزاد میشود
    redis.advance(1);
    expect(await redis.ttl(`otp:${PHONE}`)).toBe(-2);

    const afterExpiry = await request(server())
      .post('/api/auth/send-otp')
      .send({ phone: PHONE })
      .expect(201);

    expect(afterExpiry.body.data.sent).toBe(true);
    expect(afterExpiry.body.data.expiresIn).toBe(120);
  });

  it('لاگین کاربر ثبتنامنکرده: به جای «یافت نشد»، signup_required میدهد', async () => {
    const res = await request(server())
      .post('/api/auth/login')
      .send({ phone: PHONE, code: smsCodes[PHONE] })
      .expect(201);

    expect(res.body.message).toBe('signup_required');
    expect(res.body.data.signupRequired).toBe(true);
    expect(res.body.data.expiresIn).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('یافت نشد');
    expect(res.headers['set-cookie']).toBeUndefined();
    // کد همچنان معتبر است تا همان کد در ثبتنام مصرف شود
    expect(await redis.get(`otp:${PHONE}`)).toBe(smsCodes[PHONE]);
  });

  it('ثبتنام همان شماره بدون ایمیل و با همان کد قبول میشود', async () => {
    const res = await request(server())
      .post('/api/auth/sign-up')
      .send({
        fullName: 'علی تست',
        phone: PHONE,
        code: smsCodes[PHONE],
        password: 'secret123',
        birthDate: '',
      })
      .expect(201);

    expect(res.body.message).toBe('sign up successfully');
    expect(users.get(PHONE).email).toBeNull();
    expect(users.get(PHONE).birthDate).not.toBe('');
    expect(res.headers['set-cookie']?.join(' ')).toContain('access_token');
    // کد مصرف شد
    expect(await redis.get(`otp:${PHONE}`)).toBeNull();
  });

  it('ایمیل خالی و null هم در ثبتنام قبول میشوند، ایمیل نامعتبر رد میشود', async () => {
    await request(server())
      .post('/api/auth/send-otp')
      .send({ phone: OTHER_PHONE })
      .expect(201);

    const invalid = await request(server())
      .post('/api/auth/sign-up')
      .send({
        fullName: 'کاربر دوم',
        phone: OTHER_PHONE,
        code: smsCodes[OTHER_PHONE],
        password: 'secret123',
        email: 'not-an-email',
      })
      .expect(400);
    expect(JSON.stringify(invalid.body.message)).toContain('ایمیل');

    const res = await request(server())
      .post('/api/auth/sign-up')
      .send({
        fullName: 'کاربر دوم',
        phone: OTHER_PHONE,
        code: smsCodes[OTHER_PHONE],
        password: 'secret123',
        email: '',
      })
      .expect(201);

    expect(res.body.message).toBe('sign up successfully');
    expect(users.get(OTHER_PHONE).email).toBeNull();
  });

  it('بعد از ثبتنام، ورود با کد تازه کوکیها را ست میکند', async () => {
    await request(server())
      .post('/api/auth/send-otp')
      .send({ phone: PHONE })
      .expect(201);

    const res = await request(server())
      .post('/api/auth/login')
      .send({ phone: PHONE, code: smsCodes[PHONE] })
      .expect(201);

    expect(res.body.message).toBe('login successfully');
    expect(res.headers['set-cookie']?.join(' ')).toContain('access_token');
  });
});
