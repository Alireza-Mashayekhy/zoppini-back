import { BadRequestException } from '@nestjs/common';

import { PaymentGuardService } from './payment-guard.service';

const baseOrder = {
  id: 15,
  status: 'pending',
  finalPrice: 100,
  walletPayment: 0,
  clubCreditPayment: 50,
  user: { phone: '09120000000' },
} as any;

describe('PaymentGuardService Diatech credit validation', () => {
  const makeGuard = (availableCredit: number) => {
    const paymentRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
    };
    const promotionsRevalidation = { assertPayable: jest.fn() };
    const clubService = {
      getCustomer: jest
        .fn()
        .mockResolvedValue({ AvailableCredit: availableCredit }),
    };
    const guard = new PaymentGuardService(
      paymentRepo as any,
      promotionsRevalidation as any,
      clubService as any,
    );
    return { guard, clubService };
  };

  it('allows payment when the club balance still covers the reserved order share', async () => {
    const { guard, clubService } = makeGuard(500);

    await expect(guard.ensureOrderPayable(baseOrder)).resolves.toBeUndefined();
    expect(clubService.getCustomer).toHaveBeenCalledWith('09120000000');
  });

  it('blocks gateway payment if the Diatech credit balance has changed', async () => {
    const { guard } = makeGuard(499);

    await expect(guard.ensureOrderPayable(baseOrder)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
