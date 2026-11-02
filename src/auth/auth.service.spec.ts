import { UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';

import { AuthService } from './auth.service';

const PHONE = '09918690340';
const CODE = '12345';

function makeService() {
  const usersService = {
    findWithPhone: jest.fn(),
    findWithEmail: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    updateUser: jest.fn(),
  };
  const otpService = {
    verifyOtp: jest.fn().mockResolvedValue(true),
    sendOtp: jest.fn().mockResolvedValue({
      message: 'کد تایید ارسال شد',
      data: { sent: true, alreadySent: false, expiresIn: 120 },
    }),
    getRemainingTtl: jest.fn().mockResolvedValue(90),
    consumeOtp: jest.fn().mockResolvedValue(undefined),
  };
  const jwtService = {
    signAsync: jest.fn().mockResolvedValue('signed-token'),
    verifyAsync: jest.fn(),
  };
  const cartsService = {
    mergeGuestCart: jest.fn().mockResolvedValue(undefined),
  };
  const clubService = { registerCustomer: jest.fn().mockResolvedValue({}) };
  const smsService = {};
  const rahkaranService = {
    createLoyaltyMemberForUser: jest.fn().mockResolvedValue(undefined),
  };

  const service = new AuthService(
    jwtService as any,
    usersService as any,
    otpService as any,
    cartsService as any,
    clubService as any,
    smsService as any,
    rahkaranService as any,
  );

  const response = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  } as unknown as Response;

  return {
    service,
    usersService,
    otpService,
    jwtService,
    clubService,
    response,
  };
}

const emptyResponse = () =>
  ({ cookie: jest.fn(), clearCookie: jest.fn() }) as unknown as Response;

const signUpDto = (overrides: Record<string, unknown> = {}) => ({
  fullName: 'علی تست',
  phone: PHONE,
  code: CODE,
  password: 'secret123',
  ...overrides,
});

describe('AuthService.login — کاربر ثبتنامنکرده', () => {
  it('به جای «کاربری یافت نشد» نتیجهی signup_required میدهد و کد را مصرف نمیکند', async () => {
    const { service, usersService, otpService, response } = makeService();
    usersService.findWithPhone.mockResolvedValue(null);

    const result: any = await service.login(
      { phone: PHONE, code: CODE },
      undefined,
      response,
    );

    expect(result.message).toBe('signup_required');
    expect(result.data.signupRequired).toBe(true);
    expect(result.data.expiresIn).toBe(90);
    expect(otpService.verifyOtp).toHaveBeenCalledWith(PHONE, CODE, {
      consume: false,
    });
    // نباید توکن/کوکی صادر شود؛ ثبتنام بعداً انجام میشود
    expect((response as any).cookie).not.toHaveBeenCalled();
  });

  it('کد اشتباه، چه کاربر باشد چه نباشد، همان خطای verifyOtp است', async () => {
    const { service, usersService, otpService, response } = makeService();
    usersService.findWithPhone.mockResolvedValue(null);
    otpService.verifyOtp.mockRejectedValueOnce(
      new Error('کد وارد شده اشتباه است'),
    );

    await expect(
      service.login(
        { phone: PHONE, code: '00000' } as any,
        undefined,
        response,
      ),
    ).rejects.toThrow('کد وارد شده اشتباه است');
    expect(otpService.verifyOtp).toHaveBeenCalledWith(PHONE, '00000', {
      consume: false,
    });
  });

  it('کاربر موجود: کد مصرف و توکنها ست میشوند', async () => {
    const { service, usersService, otpService, response } = makeService();
    usersService.findWithPhone.mockResolvedValue({ id: 1, phone: PHONE });

    const result: any = await service.login(
      { phone: PHONE, code: CODE },
      'guest-1',
      response,
    );

    expect(result.message).toBe('login successfully');
    expect(otpService.verifyOtp).toHaveBeenCalledWith(PHONE, CODE, {
      consume: true,
    });
    expect((response as any).cookie).toHaveBeenCalledTimes(2);
  });
});

describe('AuthService.signUp — ایمیل اختیاری', () => {
  it('بدون ایمیل ثبتنام میکند و email=null ذخیره میشود', async () => {
    const { service, usersService, clubService } = makeService();
    usersService.findWithPhone.mockResolvedValue(null);
    usersService.create.mockResolvedValue({ id: 7 });

    const result: any = await service.signUp(
      signUpDto(),
      undefined,
      emptyResponse(),
    );

    expect(result.message).toBe('sign up successfully');
    const createArg = usersService.create.mock.calls[0][0];
    expect(createArg.email).toBeNull();
    expect(createArg.password).not.toBe('secret123');
    expect(clubService.registerCustomer.mock.calls[0][0].email).toBeUndefined();
  });

  it('ایمیل خالی، null و فقط فاصله همگی به null تبدیل میشوند', async () => {
    for (const email of ['', '   ', null]) {
      const { service, usersService } = makeService();
      usersService.findWithPhone.mockResolvedValue(null);
      usersService.create.mockResolvedValue({ id: 7 });

      await service.signUp(signUpDto({ email }), undefined, emptyResponse());
      expect(usersService.create.mock.calls[0][0].email).toBeNull();
    }
  });

  it('ایمیل معتبر trim میشود و به باشگاه مشتریان هم میرود', async () => {
    const { service, usersService, clubService } = makeService();
    usersService.findWithPhone.mockResolvedValue(null);
    usersService.create.mockResolvedValue({ id: 7 });

    await service.signUp(
      signUpDto({ email: '  user@example.com  ' }),
      undefined,
      emptyResponse(),
    );

    expect(usersService.create.mock.calls[0][0].email).toBe('user@example.com');
    expect(clubService.registerCustomer.mock.calls[0][0].email).toBe(
      'user@example.com',
    );
  });

  it('تاریخ تولد خالی/نامعتبر به جای رشتهی خالی، حذف میشود', async () => {
    for (const birthDate of ['', 'not-a-date']) {
      const { service, usersService } = makeService();
      usersService.findWithPhone.mockResolvedValue(null);
      usersService.create.mockResolvedValue({ id: 7 });

      await service.signUp(
        signUpDto({ birthDate }),
        undefined,
        emptyResponse(),
      );
      expect(usersService.create.mock.calls[0][0].birthDate).toBeUndefined();
    }
  });

  it('شماره تکراری رد میشود ولی کد کاربر مصرف نمیشود', async () => {
    const { service, usersService, otpService } = makeService();
    usersService.findWithPhone.mockResolvedValue({ id: 1 });

    await expect(
      service.signUp(signUpDto() as any, undefined, emptyResponse()),
    ).rejects.toThrow('کاربر با این شماره تلفن وجود دارد');
    expect(otpService.verifyOtp).toHaveBeenCalledWith(PHONE, CODE, {
      consume: false,
    });
    expect(otpService.consumeOtp).not.toHaveBeenCalled();
  });

  it('کد قبل از جستوجوی کاربر بررسی میشود (جلوی افشای ثبتنامبودن شماره)', async () => {
    const { service, usersService, otpService } = makeService();
    usersService.findWithPhone.mockResolvedValue(null);
    usersService.create.mockResolvedValue({ id: 7 });
    otpService.verifyOtp.mockRejectedValueOnce(
      new Error('کد وارد شده اشتباه است'),
    );

    await expect(
      service.signUp(signUpDto() as any, undefined, emptyResponse()),
    ).rejects.toThrow('کد وارد شده اشتباه است');
    expect(usersService.findWithPhone).not.toHaveBeenCalled();
  });

  it('ایمیل تکراری پیام فارسی میدهد و کد را نسوزاند', async () => {
    const { service, usersService, otpService } = makeService();
    usersService.findWithPhone.mockResolvedValue(null);
    usersService.findWithEmail.mockResolvedValue({ id: 3 });

    await expect(
      service.signUp(
        signUpDto({ email: 'user@example.com' }) as any,
        undefined,
        emptyResponse(),
      ),
    ).rejects.toThrow('کاربر با این ایمیل وجود دارد');
    expect(otpService.consumeOtp).not.toHaveBeenCalled();
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('ثبتنام موفق کد را دقیقاً یکبار مصرف میکند', async () => {
    const { service, usersService, otpService } = makeService();
    usersService.findWithPhone.mockResolvedValue(null);
    usersService.create.mockResolvedValue({ id: 7 });

    await service.signUp(signUpDto(), undefined, emptyResponse());

    expect(otpService.consumeOtp).toHaveBeenCalledTimes(1);
    expect(otpService.consumeOtp).toHaveBeenCalledWith(PHONE);
  });
});

describe('AuthService — سایر مسیرها', () => {
  it('sendCode نتیجهی حاوی expiresIn را پاس میدهد', async () => {
    const { service, otpService } = makeService();
    const result: any = await service.sendCode({ phone: PHONE });
    expect(result.data).toEqual({
      sent: true,
      alreadySent: false,
      expiresIn: 120,
    });
    expect(otpService.sendOtp).toHaveBeenCalledWith(PHONE);
  });

  it('forgotPassword برای کاربر ناموجود همچنان خطا میدهد (مختص فراموشی رمز)', async () => {
    const { service, usersService } = makeService();
    usersService.findWithPhone.mockResolvedValue(null);
    await expect(service.forgotPassword({ phone: PHONE })).rejects.toThrow(
      'کاربری با این شماره تلفن یافت نشد.',
    );
  });

  it('refresh بدون توکن / با توکن نامعتبر 401 میدهد نه 500', async () => {
    const { service, jwtService } = makeService();
    const response = { cookie: jest.fn() } as unknown as Response;

    await expect(service.refresh(undefined, response)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    jwtService.verifyAsync.mockRejectedValueOnce(new Error('jwt expired'));
    await expect(
      service.refresh('broken-token', response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('عمر کوکی access_token با expiresIn توکن (۶ ساعت) برابر است', async () => {
    const { service, usersService, jwtService, response } = makeService();
    usersService.findWithPhone.mockResolvedValue({ id: 1, phone: PHONE });

    await service.login({ phone: PHONE, code: CODE }, undefined, response);

    const accessCookie = (response as any).cookie.mock.calls.find(
      ([name]: [string]) => name === 'access_token',
    );
    expect(accessCookie[2].maxAge).toBe(6 * 60 * 60 * 1000);
    expect(jwtService.signAsync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expiresIn: '6h' }),
    );
  });
});
