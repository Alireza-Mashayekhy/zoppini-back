import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { ClubController } from './club.controller';
import { ClubService } from './club.service';

/**
 * صفحه‌ی باشگاه مشتریان در فرانت، برای هر کیف پول تراکنش‌ها را از
 * `/club/wallets/:id/transactions` می‌گیرد. مجوز این مسیر بر اساس لیست
 * کیف پول‌های کاربر است؛ اگر آن لیست فقط از فیلد `Wallets` داخل DTO مشتری
 * خوانده شود و دایاتک آن فیلد را برنگرداند، هر درخواست تراکنش 403 می‌شود و
 * بخش «کیف پول‌های باشگاه» عملاً کار نمی‌کند.
 */
describe('ClubController wallet transactions authorization', () => {
  const user = { id: 1, phone: '09120000000', fullName: 'Test User' };

  const makeController = (overrides: Partial<Record<string, jest.Mock>>) => {
    const clubService = {
      getCustomer: jest.fn(),
      getCustomerWallets: jest.fn(),
      getCustomerWalletTransactions: jest.fn(),
      registerCustomer: jest.fn(),
      ...overrides,
    } as unknown as ClubService;

    return { controller: new ClubController(clubService), clubService };
  };

  it('allows transactions for a wallet resolved from the wallets endpoint', async () => {
    const { controller, clubService } = makeController({
      // DTO مشتری عمداً `Wallets` ندارد (مثل بعضی نسخه‌های دایاتک)
      getCustomer: jest.fn().mockResolvedValue({
        CustomerCode: '09120000000',
        FirstName: 'Test',
        LastName: 'User',
      }),
      getCustomerWallets: jest
        .fn()
        .mockResolvedValue([{ Id: 22, AvailableCredit: 2500 }]),
      getCustomerWalletTransactions: jest
        .fn()
        .mockResolvedValue([{ Id: 91, Amount: 700 }]),
    });

    await expect(
      controller.getMyWalletTransactions({ user } as any, 22),
    ).resolves.toEqual([{ Id: 91, Amount: 700 }]);

    expect(clubService.getCustomerWalletTransactions).toHaveBeenCalledWith(22);
  });

  it('still rejects a wallet that does not belong to the user', async () => {
    const { controller } = makeController({
      getCustomer: jest
        .fn()
        .mockResolvedValue({ CustomerCode: '09120000000' }),
      getCustomerWallets: jest
        .fn()
        .mockResolvedValue([{ Id: 22, AvailableCredit: 2500 }]),
    });

    await expect(
      controller.getMyWalletTransactions({ user } as any, 999),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('falls back to the customer DTO wallets when the wallets endpoint fails', async () => {
    const { controller } = makeController({
      getCustomer: jest.fn().mockResolvedValue({
        CustomerCode: '09120000000',
        Wallets: [{ Id: 33, AvailableCredit: 100 }],
      }),
      getCustomerWallets: jest
        .fn()
        .mockRejectedValue(new Error('upstream down')),
      getCustomerWalletTransactions: jest
        .fn()
        .mockResolvedValue([{ Id: 1 }]),
    });

    await expect(
      controller.getMyWalletTransactions({ user } as any, 33),
    ).resolves.toEqual([{ Id: 1 }]);
  });

  it('requires an authenticated phone on the token', async () => {
    const { controller } = makeController({});

    await expect(
      controller.getMyWalletTransactions({ user: { id: 1 } } as any, 22),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
