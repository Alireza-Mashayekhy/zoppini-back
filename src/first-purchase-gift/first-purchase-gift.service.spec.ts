import { validate } from 'class-validator';
import { Order } from 'src/order/entities/order.entity';

import { UpdateFirstPurchaseGiftDto } from './dto/update-first-purchase-gift.dto';
import { FirstPurchaseGiftClaim } from './entities/first-purchase-gift-claim.entity';
import { FirstPurchaseGiftSettings } from './entities/first-purchase-gift-settings.entity';
import { FirstPurchaseGiftService } from './first-purchase-gift.service';

const activeSettings = {
  id: 1,
  isActive: true,
  discountPercent: 15,
  title: 'هدیه اولین خرید',
  description: 'توضیحات',
  startsAt: null,
  endsAt: null,
  popupEnabled: true,
  announcementEnabled: true,
  popupFrequency: 'session' as const,
  stackWithDiscountCodes: false,
  stackWithSalePrices: false,
};

describe('FirstPurchaseGiftService', () => {
  const createService = (overrides?: {
    settings?: Partial<FirstPurchaseGiftSettings>;
    successfulOrder?: boolean;
    claim?: Partial<FirstPurchaseGiftClaim> | null;
  }) => {
    const settingsRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue({ ...activeSettings, ...overrides?.settings }),
      save: jest.fn(value => Promise.resolve(value)),
    };
    const claimRepo = {
      findOne: jest.fn().mockResolvedValue(overrides?.claim ?? null),
      save: jest.fn(value => Promise.resolve(value)),
    };
    const orderRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue(overrides?.successfulOrder ? { id: 20 } : null),
    };
    const userRepo = { findOne: jest.fn() };
    return {
      service: new FirstPurchaseGiftService(
        settingsRepo as never,
        claimRepo as never,
        orderRepo as never,
        userRepo as never,
      ),
      settingsRepo,
      claimRepo,
      orderRepo,
    };
  };

  it('grants eligibility when the only website order is unpaid', async () => {
    const { service, orderRepo } = createService();
    const result = await service.getEligibility(7);

    expect(result.data.eligible).toBe(true);
    expect(orderRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          user: { id: 7 },
          status: expect.anything(),
        }),
      }),
    );
    const status = orderRepo.findOne.mock.calls[0][0].where.status;
    expect((status as { value: unknown[] }).value).toEqual([
      'paid',
      'shipped',
      'delivered',
    ]);
  });

  it('does not grant eligibility after a paid website order', async () => {
    const { service } = createService({ successfulOrder: true });
    const result = await service.getEligibility(7);
    expect(result.data).toMatchObject({
      eligible: false,
      reason: 'already_purchased',
    });
  });

  it('does not grant eligibility outside the configured date window', async () => {
    const { service } = createService({
      settings: { startsAt: new Date(Date.now() + 60_000) },
    });
    const result = await service.getEligibility(7);
    expect(result.data).toMatchObject({ eligible: false, reason: 'inactive' });
  });

  it('validates the configurable discount percentage', async () => {
    const invalid = Object.assign(new UpdateFirstPurchaseGiftDto(), {
      discountPercent: 101,
    });
    const errors = await validate(invalid);
    expect(errors.some(error => error.property === 'discountPercent')).toBe(
      true,
    );
  });

  it('rejects an invalid settings date range without saving', async () => {
    const { service, settingsRepo } = createService();
    await expect(
      service.updateSettings({
        startsAt: '2026-12-02T12:00:00.000Z',
        endsAt: '2026-12-01T12:00:00.000Z',
      }),
    ).rejects.toThrow('تاریخ پایان باید بعد از تاریخ شروع باشد.');
    expect(settingsRepo.save).not.toHaveBeenCalled();
  });

  it('reports guests without granting checkout eligibility', async () => {
    const { service } = createService();
    const result = await service.getEligibility();
    expect(result.data).toMatchObject({
      authenticated: false,
      eligible: false,
      reason: 'guest',
    });
  });

  it('rejects a second claim when the unique customer entitlement is already redeemed', async () => {
    const { service } = createService({ claim: { status: 'redeemed' } });
    const claimRepository = {
      findOne: jest.fn().mockResolvedValue({ status: 'redeemed' }),
      save: jest.fn(),
    };
    const manager = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce({ id: 7 })
        .mockResolvedValueOnce(activeSettings),
      getRepository: jest.fn((entity: unknown) =>
        entity === Order
          ? { findOne: jest.fn().mockResolvedValue(null) }
          : claimRepository,
      ),
    };

    await expect(
      service.reserveInTransaction(manager as never, 7, 90, 15, 100, {
        stackWithDiscountCodes: false,
        stackWithSalePrices: false,
        usedDiscountCode: false,
      }),
    ).rejects.toThrow('هدیه اولین خرید قبلاً استفاده شده است.');
  });

  it('marks the unique claim redeemed inside the payment transaction', async () => {
    const claim = {
      userId: 7,
      orderId: 90,
      status: 'reserved',
      discountAmount: 150,
      reservedUntil: new Date(Date.now() + 60_000),
    };
    const claimRepository = {
      findOne: jest.fn().mockResolvedValue(claim),
      save: jest.fn(value => Promise.resolve(value)),
    };
    const orderRepository = { findOne: jest.fn().mockResolvedValue(null) };
    const manager = {
      findOne: jest.fn().mockResolvedValue(activeSettings),
      getRepository: jest.fn((entity: unknown) =>
        entity === Order ? orderRepository : claimRepository,
      ),
    };
    const { service } = createService();

    await service.redeemInTransaction(manager as never, 7, {
      id: 90,
      firstPurchaseGiftDiscount: 150,
    } as never);

    expect(claim).toMatchObject({
      status: 'redeemed',
      redeemedAt: expect.any(Date),
    });
    expect(claimRepository.save).toHaveBeenCalledWith(claim);
  });

  it('releases a pending claim after its reservation expires', async () => {
    const { service, claimRepo } = createService({
      claim: {
        status: 'reserved',
        orderId: 90,
        reservedUntil: new Date(Date.now() - 1_000),
      },
    });
    const result = await service.getEligibility(7);
    expect(result.data.eligible).toBe(true);
    expect(result.data.reason).toBe('eligible');
    expect(claimRepo.findOne).toHaveBeenCalledWith({ where: { userId: 7 } });
  });

  it('rejects payment for an expired reservation', async () => {
    const expired = {
      userId: 7,
      orderId: 90,
      status: 'reserved',
      reservedUntil: new Date(Date.now() - 1_000),
    };
    const expiringService = new FirstPurchaseGiftService(
      { findOne: jest.fn().mockResolvedValue(activeSettings) } as never,
      { findOne: jest.fn().mockResolvedValue(expired) } as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
    );

    await expect(expiringService.assertClaimPayable(7, 90)).rejects.toThrow(
      'رزرو هدیه اولین خرید منقضی یا نامعتبر شده است؛ سفارش را دوباره ثبت کنید.',
    );
  });
});
