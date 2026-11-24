import { HttpService } from '@nestjs/axios';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { of, throwError } from 'rxjs';
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

describe('Auth HTTP — ماتریس کامل سناریوهای ورود، ثبت‌نام، راهکاران و موارد مرزی', () => {
  let app: NestExpressApplication;
  let redis: FakeRedis;
  let redisBroken = false;
  let dbBroken = false;
  let smsShouldFail = false;
  let rahkaranHttpMock: jest.Mock;
  let clubRegisterMock: jest.Mock;
  let rahkaranService: RahkaranService;

  const smsCodes: Record<string, string> = {};
  const usersById = new Map<number, any>();
  const usersByPhone = new Map<string, any>();

  function toPersianDigits(val: string) {
    return val.replace(/\d/g, d => String.fromCharCode(0x06f0 + Number(d)));
  }

  beforeAll(async () => {
    redis = new FakeRedis();
    rahkaranHttpMock = jest.fn();
    clubRegisterMock = jest.fn().mockResolvedValue({ id: 'club-1' });

    const usersServiceMock = {
      findWithPhone: (phone: string) => {
        if (dbBroken) {
          return Promise.reject(
            Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), {
              code: 'ECONNREFUSED',
            }),
          );
        }
        return Promise.resolve(usersByPhone.get(phone) ?? null);
      },
      findWithEmail: (email: string) => {
        for (const u of usersById.values()) {
          if (u.email === email) return Promise.resolve(u);
        }
        return Promise.resolve(null);
      },
      findOne: (id: number) => Promise.resolve(usersById.get(id) ?? null),
      create: (dto: any) => {
        if (dbBroken) {
          return Promise.reject(
            Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), {
              code: 'ECONNREFUSED',
            }),
          );
        }
        if (usersByPhone.has(dto.phone)) {
          return Promise.reject(new Error('Duplicate phone'));
        }
        const user = {
          id: usersById.size + 1,
          isActive: true,
          roles: ['user'],
          rahkaranId: null,
          loyaltyMemberSyncedAt: null,
          ...dto,
        };
        usersById.set(user.id, user);
        usersByPhone.set(user.phone, user);
        return Promise.resolve(user);
      },
      update: (id: number, patch: any) => {
        const u = usersById.get(id);
        if (!u) return Promise.reject(new Error('User not found'));
        Object.assign(u, patch);
        return Promise.resolve(u);
      },
      updateUser: (id: number, patch: any) => {
        const u = usersById.get(id);
        if (u) Object.assign(u, patch);
        return Promise.resolve(u);
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        OtpService,
        RahkaranService,
        AuthGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({
                RAHKARAN_BASE_URL: 'https://rahkaran.mock.local',
                RAHKARAN_USERNAME: 'zoppini',
                RAHKARAN_PASSWORD: 'secret',
                RAHKARAN_MACHINE_NAME: 'M1',
                RAHKARAN_AUTO_LOGIN: 'false',
              })[key],
          },
        },
        {
          provide: HttpService,
          useValue: { request: rahkaranHttpMock },
        },
        {
          provide: RedisService,
          useValue: {
            getClient: () => {
              if (redisBroken) {
                throw Object.assign(new Error('Redis connection closed'), {
                  code: 'ECONNREFUSED',
                });
              }
              return redis;
            },
          },
        },
        {
          provide: SmsService,
          useValue: {
            sendOtp: (phone: string, code: string) => {
              if (smsShouldFail) {
                return Promise.resolve({ success: false });
              }
              smsCodes[phone] = code;
              return Promise.resolve({ success: true });
            },
          },
        },
        { provide: UsersService, useValue: usersServiceMock },
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
          useValue: { registerCustomer: clubRegisterMock },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    await app.init();

    rahkaranService = app.get(RahkaranService);
    (rahkaranService as any).state = {
      sessionId: 'sess-mock-1',
      cookie: 'AuthCookie=1',
      cashRegister: {
        cashierId: 1,
        userId: 1,
        cashRegisterId: 10,
        cashierTitle: 'صندوق',
        cashRegisterTitle: 'صندوق ۱',
        retailSessionId: 99,
        sessionNumber: '99',
        retailInteriorSectionId: null,
        retailInteriorSectionTitle: '',
        retailInteriorSectionType: 0,
        hasSupervisor: false,
        retailShopID: 5,
        kioskIP: null,
      },
      authenticatedAt: new Date(),
      lastTickAt: null,
    };
  });

  afterEach(() => {
    redisBroken = false;
    dbBroken = false;
    smsShouldFail = false;
    rahkaranHttpMock.mockReset();
    clubRegisterMock.mockClear();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const server = () => app.getHttpServer();

  it('سناریو راهکاران ۱: ثبت‌نام موفق کاربر جدید + ساخت مشتری در راهکاران + ذخیره rahkaranId + ثبت Loyalty Membership + CustomerCode باشگاه', async () => {
    const phone = '09123334455';
    let createdInRahkaran = false;

    rahkaranHttpMock.mockImplementation(
      (cfg: { url: string; method?: string }) => {
        if (cfg.url.includes('/ESales.svc/customers')) {
          return of({
            status: 200,
            headers: {},
            data: {
              metadata: { isSuccessfull: true },
              result: createdInRahkaran ? [{ id: 8801, mobile: phone }] : [],
            },
          });
        }
        if (cfg.url.includes('/CustomerService.svc/customer')) {
          createdInRahkaran = true;
          return of({
            status: 200,
            headers: {},
            data: { metadata: { isSuccessful: true }, result: true },
          });
        }
        if (cfg.url.includes('/RetailLoyaltyMemberService.svc/loyaltyMember')) {
          return of({
            status: 200,
            headers: {},
            data: { metadata: { isSuccessful: true }, result: true },
          });
        }
        throw new Error(`Unexpected URL: ${cfg.url}`);
      },
    );

    await request(server())
      .post('/api/auth/send-otp')
      .send({ phone: '+98 912 333 4455' })
      .expect(201);

    const persianOtp = toPersianDigits(smsCodes[phone]);
    const signUpRes = await request(server())
      .post('/api/auth/sign-up')
      .send({
        fullName: 'مریم رضایی',
        phone: '۰۹۱۲۳۳۳۴۴۵۵',
        code: persianOtp,
        password: 'password123',
        birthDate: '',
      })
      .expect(201);

    expect(signUpRes.body.message).toBe('sign up successfully');
    expect(signUpRes.headers['x-correlation-id']).toBeTruthy();

    const savedUser = usersByPhone.get(phone);
    expect(savedUser).toBeDefined();
    expect(savedUser.rahkaranId).toBe(8801);
    expect(savedUser.loyaltyMemberSyncedAt).toBeInstanceOf(Date);
    expect(clubRegisterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'مریم',
        lastName: 'رضایی',
        customerCode: phone,
      }),
    );

    // فراخوانی مجدد (مثلاً از نظرسنجی/retry) مشتری یا عضو وفاداری تکراری نمی‌سازد
    rahkaranHttpMock.mockClear();
    const secondSync = await rahkaranService.createLoyaltyMemberForUser(
      savedUser.id,
    );
    expect(secondSync).toEqual({
      customerId: 8801,
      skipped: 'already_synced',
    });
    expect(rahkaranHttpMock).not.toHaveBeenCalled();
  });

  it('سناریو راهکاران ۲: خطای موقت/قطع راهکاران در حین عضویت وفاداری باعث شکست ثبت‌نام یا مشتری تکراری در تلاش بعدی نمی‌شود', async () => {
    const phone = '09124445566';
    let customerCreatedCount = 0;
    let loyaltyAttemptCount = 0;

    rahkaranHttpMock.mockImplementation((cfg: { url: string }) => {
      if (cfg.url.includes('/ESales.svc/customers')) {
        return of({
          status: 200,
          headers: {},
          data: {
            metadata: { isSuccessfull: true },
            result:
              customerCreatedCount > 0 ? [{ id: 9902, mobile: phone }] : [],
          },
        });
      }
      if (cfg.url.includes('/CustomerService.svc/customer')) {
        customerCreatedCount++;
        return of({
          status: 200,
          headers: {},
          data: { metadata: { isSuccessful: true }, result: true },
        });
      }
      if (cfg.url.includes('/RetailLoyaltyMemberService.svc/loyaltyMember')) {
        loyaltyAttemptCount++;
        if (loyaltyAttemptCount === 1) {
          const timeoutErr = Object.assign(new Error('timeout of 30000ms'), {
            code: 'ETIMEDOUT',
            isAxiosError: true,
          });
          return throwError(() => timeoutErr);
        }
        return of({
          status: 200,
          headers: {},
          data: { metadata: { isSuccessful: true }, result: true },
        });
      }
      throw new Error(`Unexpected URL: ${cfg.url}`);
    });

    await request(server())
      .post('/api/auth/send-otp')
      .send({ phone })
      .expect(201);

    // ثبت‌نام کاربر با وجود خطای راهکاران نباید 500 بدهد، ولی loyaltyMemberSyncedAt هم به اشتباه پر نمی‌شود
    await request(server())
      .post('/api/auth/sign-up')
      .send({
        fullName: 'امیر حسینی',
        phone,
        code: smsCodes[phone],
        password: 'password123',
      })
      .expect(201);

    const savedUser = usersByPhone.get(phone);
    expect(savedUser.rahkaranId).toBe(9902);
    expect(savedUser.loyaltyMemberSyncedAt).toBeNull();
    expect(customerCreatedCount).toBe(1);

    // بازیابی بعدی فقط عضویت وفاداری باقی‌مانده را تکمیل می‌کند و مشتری تکراری نمی‌سازد
    await rahkaranService.createLoyaltyMemberForUser(savedUser.id);
    expect(customerCreatedCount).toBe(1);
    expect(loyaltyAttemptCount).toBe(2);
    expect(savedUser.loyaltyMemberSyncedAt).toBeInstanceOf(Date);
  });

  it('سناریوهای ورود: فرمت‌های شماره، OTP اشتباه، OTP منقضی، ارسال مجدد و ورود با کد جدید، و کاربر غیرفعال', async () => {
    const phone = '09123334455';

    await request(server())
      .post('/api/auth/send-otp')
      .send({ phone: '989123334455' })
      .expect(201);

    // OTP اشتباه -> 400
    await request(server())
      .post('/api/auth/login')
      .send({ phone: '0912-333-4455', code: '00000' })
      .expect(400);

    // انقضای OTP -> 400
    redis.advance(121);
    const expiredRes = await request(server())
      .post('/api/auth/login')
      .send({ phone, code: smsCodes[phone] })
      .expect(400);
    expect(expiredRes.body.message).toContain('منقضی');

    // ارسال مجدد OTP و ورود موفق با فرمت متفاوت شماره و ارقام فارسی
    await request(server())
      .post('/api/auth/send-otp')
      .send({ phone: '9123334455' })
      .expect(201);

    await request(server())
      .post('/api/auth/login')
      .send({
        phone: '+۹۸ ۹۱۲ ۳۳۳ ۴۴۵۵',
        code: toPersianDigits(smsCodes[phone]),
      })
      .expect(201);

    // مسدودسازی کاربر غیرفعال (isActive=false) -> 403 بدون مصرف OTP
    usersByPhone.get(phone).isActive = false;
    await request(server())
      .post('/api/auth/send-otp')
      .send({ phone })
      .expect(201);

    await request(server())
      .post('/api/auth/login')
      .send({ phone, code: smsCodes[phone] })
      .expect(403);
    expect(await redis.get(`otp:${phone}`)).toBe(smsCodes[phone]);
    usersByPhone.get(phone).isActive = true;
  });

  it('سناریوی هم‌زمانی ثبت‌نام و کلیک چندباره: فقط یک کاربر ساخته می‌شود و کد یک‌بار مصرف می‌شود', async () => {
    const phone = '09127778899';
    rahkaranHttpMock.mockReturnValue(
      of({
        status: 200,
        headers: {},
        data: { metadata: { isSuccessful: true }, result: [{ id: 5001 }] },
      }),
    );

    await request(server())
      .post('/api/auth/send-otp')
      .send({ phone })
      .expect(201);

    const payload = {
      fullName: 'کاربر همزمان',
      phone,
      code: smsCodes[phone],
      password: 'password123',
    };

    const [r1, r2] = await Promise.all([
      request(server()).post('/api/auth/sign-up').send(payload),
      request(server()).post('/api/auth/sign-up').send(payload),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses[0]).toBe(201);
    expect([400, 409]).toContain(statuses[1]);
    expect([...usersById.values()].filter(u => u.phone === phone)).toHaveLength(
      1,
    );
  });

  it('سناریوهای مرزی: درخواست خالی/ناقص، طول نامعتبر، غیرعددی، قطع Redis، قطع دیتابیس و خطای پیامک', async () => {
    // درخواست خالی
    await request(server()).post('/api/auth/login').send({}).expect(400);
    await request(server()).post('/api/auth/sign-up').send({}).expect(400);

    // طول نامعتبر OTP
    await request(server())
      .post('/api/auth/login')
      .send({ phone: '09123334455', code: '1234' })
      .expect(400);
    await request(server())
      .post('/api/auth/login')
      .send({ phone: '09123334455', code: '123456' })
      .expect(400);

    // OTP غیرعددی
    await request(server())
      .post('/api/auth/login')
      .send({ phone: '09123334455', code: '12ab5' })
      .expect(400);

    // خطای سرویس پیامک -> 502 و عدم باقی‌ماندن کد ارسال‌نشده در Redis
    smsShouldFail = true;
    await request(server())
      .post('/api/auth/send-otp')
      .send({ phone: '09129990000' })
      .expect(502);
    expect(await redis.get('otp:09129990000')).toBeNull();
    smsShouldFail = false;

    // قطع Redis -> 503 بدون افشای جزئیات داخلی
    redisBroken = true;
    const redisRes = await request(server())
      .post('/api/auth/login')
      .send({ phone: '09123334455', code: '12345' })
      .expect(503);
    expect(JSON.stringify(redisRes.body)).not.toContain('ECONNREFUSED');
    redisBroken = false;

    // قطع دیتابیس -> 503 و حفظ کد OTP معتبر برای تلاش مجدد
    const dbPhone = '09128889900';
    await request(server())
      .post('/api/auth/send-otp')
      .send({ phone: dbPhone })
      .expect(201);

    dbBroken = true;
    const dbRes = await request(server())
      .post('/api/auth/login')
      .send({ phone: dbPhone, code: smsCodes[dbPhone] })
      .expect(503);
    expect(JSON.stringify(dbRes.body)).not.toContain('ECONNREFUSED');
    expect(await redis.get(`otp:${dbPhone}`)).toBe(smsCodes[dbPhone]);
    dbBroken = false;
  });
});
