import * as bcrypt from 'bcrypt';

import { GamificationService } from './gamification.service';

/**
 * ثبت عضویت وفاداری در نظرسنجی برای کاربری که از قبل ثبت‌نام کرده است.
 *
 * باگ واقعی: در نسخهٔ قبلی `createLoyaltyMemberForUser(newUser.id)` بیرون از
 * `if (!user)` صدا زده می‌شد؛ برای کاربر موجود `newUser` تعریف‌نشده بود،
 * `newUser.id` خطای TypeError می‌داد، catch آن را بی‌صدا می‌خورد و در نتیجه
 * عضویت وفاداری برای این کاربران هرگز ثبت نمی‌شد.
 */
describe('GamificationService — loyalty registration for existing users', () => {
  const dto = {
    fullName: 'سارا محمدی',
    phone: '09121234567',
    birthDate: '1372/05/12',
    answers: [
      { questionNumber: 1, optionNumber: 1 },
      { questionNumber: 2, optionNumber: 2 },
      { questionNumber: 3, optionNumber: 1 },
      { questionNumber: 4, optionNumber: 3 },
    ],
  };

  let participationRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let answerRepo: { create: jest.Mock };
  let discountRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let clubService: { registerCustomer: jest.Mock };
  let usersService: { findWithPhone: jest.Mock; create: jest.Mock };
  let rahkaranService: { createLoyaltyMemberForUser: jest.Mock };
  let service: GamificationService;

  beforeEach(() => {
    participationRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(input => ({ ...input, id: 55 })),
      save: jest.fn(input => Promise.resolve({ ...input, id: 55 })),
    };

    answerRepo = {
      create: jest.fn(input => ({ ...input, id: 1 })),
    };

    discountRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 3,
        code: 'WELCOME',
        users: [],
      }),
      create: jest.fn(input => ({ ...input, id: 3 })),
      save: jest.fn(input => Promise.resolve(input)),
    };

    clubService = { registerCustomer: jest.fn() };
    usersService = { findWithPhone: jest.fn(), create: jest.fn() };
    rahkaranService = {
      createLoyaltyMemberForUser: jest.fn().mockResolvedValue({
        customerId: 77,
      }),
    };

    service = new GamificationService(
      participationRepo as any,
      answerRepo as any,
      discountRepo as any,
      clubService as any,
      usersService as any,
      rahkaranService as any,
    );

    // لاگ‌ها در تست‌ها فقط نویز هستند.
    (service as any).logger = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    };
  });

  it('registers loyalty for an existing user with that user id', async () => {
    usersService.findWithPhone.mockResolvedValue({
      id: 7,
      phone: dto.phone,
      fullName: dto.fullName,
    });

    await service.create(dto);

    expect(rahkaranService.createLoyaltyMemberForUser).toHaveBeenCalledWith(7);
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('never creates the survey user with the old shared password', async () => {
    usersService.findWithPhone.mockResolvedValue(null);
    usersService.create.mockResolvedValue({ id: 11, phone: dto.phone });

    await service.create(dto);

    const created = usersService.create.mock.calls[0][0];

    // رمز هش‌شده نباید همان «۱۲۳۴۵۶۷۸۹» عمومی باشد
    expect(await bcrypt.compare('123456789', created.password)).toBe(false);
    expect(created.password).toMatch(/^\$2[aby]\$/);
  });

  it('registers loyalty for a newly created user', async () => {
    usersService.findWithPhone.mockResolvedValue(null);
    usersService.create.mockResolvedValue({ id: 11, phone: dto.phone });

    await service.create(dto);

    expect(usersService.create).toHaveBeenCalled();
    expect(rahkaranService.createLoyaltyMemberForUser).toHaveBeenCalledWith(11);
  });

  it('does not fail the survey when Rahkaran rejects the loyalty member', async () => {
    usersService.findWithPhone.mockResolvedValue({ id: 7, phone: dto.phone });
    rahkaranService.createLoyaltyMemberForUser.mockRejectedValue(
      new Error('Rahkaran HTTP 500'),
    );

    const result = await service.create(dto);

    expect(result.message).toContain('نظر شما');
    expect(clubService.registerCustomer).toHaveBeenCalled();
    expect(participationRepo.save).toHaveBeenCalled();
  });

  it('does not fail the survey when Diatech club registration fails', async () => {
    usersService.findWithPhone.mockResolvedValue({ id: 7, phone: dto.phone });
    clubService.registerCustomer.mockRejectedValue(new Error('club down'));

    const result = await service.create(dto);

    expect(result.message).toContain('نظر شما');
    expect(participationRepo.save).toHaveBeenCalled();
  });
});
