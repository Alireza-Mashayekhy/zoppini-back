import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { User } from 'src/users/entities/user.entity';
import { EntityManager, In, Not, Repository } from 'typeorm';

import { UpdateFirstPurchaseGiftDto } from './dto/update-first-purchase-gift.dto';
import { FirstPurchaseGiftClaim } from './entities/first-purchase-gift-claim.entity';
import { FirstPurchaseGiftSettings } from './entities/first-purchase-gift-settings.entity';

const SUCCESSFUL_ONLINE_STATUSES = [
  OrderStatus.PAID,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];
const RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DESCRIPTION =
  'این هدیه اختصاصی برای اولین خرید آنلاین شما از وب‌سایت زوپینی در نظر گرفته شده است.';

export interface FirstPurchaseGiftEligibility {
  authenticated: boolean;
  eligible: boolean;
  reason:
    | 'eligible'
    | 'guest'
    | 'inactive'
    | 'already_purchased'
    | 'redeemed'
    | 'reserved';
  config: {
    discountPercent: number;
    title: string;
    description: string;
    stackWithDiscountCodes: boolean;
  } | null;
}

@Injectable()
export class FirstPurchaseGiftService implements OnModuleInit {
  constructor(
    @InjectRepository(FirstPurchaseGiftSettings)
    private readonly settingsRepo: Repository<FirstPurchaseGiftSettings>,
    @InjectRepository(FirstPurchaseGiftClaim)
    private readonly claimRepo: Repository<FirstPurchaseGiftClaim>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSettings();
  }

  private async ensureSettings(): Promise<FirstPurchaseGiftSettings> {
    let settings = await this.settingsRepo.findOne({ where: { id: 1 } });
    if (settings) return settings;

    settings = this.settingsRepo.create({
      id: 1,
      isActive: true,
      discountPercent: 15,
      title: 'هدیه اولین خرید',
      description: DEFAULT_DESCRIPTION,
      startsAt: null,
      endsAt: null,
      popupEnabled: true,
      announcementEnabled: true,
      popupFrequency: 'session',
      stackWithDiscountCodes: false,
      stackWithSalePrices: false,
    });

    try {
      return await this.settingsRepo.save(settings);
    } catch (error) {
      // Another application instance may have inserted the singleton row.
      const existing = await this.settingsRepo.findOne({ where: { id: 1 } });
      if (existing) return existing;
      throw error;
    }
  }

  private isLive(
    settings: FirstPurchaseGiftSettings | null | undefined,
    now = new Date(),
  ): settings is FirstPurchaseGiftSettings {
    return Boolean(
      settings?.isActive &&
      (!settings.startsAt || settings.startsAt <= now) &&
      (!settings.endsAt || settings.endsAt >= now),
    );
  }

  private async hasSuccessfulWebsiteOrder(
    userId: number,
    exceptOrderId?: number,
    manager?: EntityManager,
  ): Promise<boolean> {
    const repo = manager?.getRepository(Order) ?? this.orderRepo;
    const where: Record<string, unknown> = {
      user: { id: userId },
      status: In(SUCCESSFUL_ONLINE_STATUSES),
    };
    if (exceptOrderId) where.id = Not(exceptOrderId);
    return Boolean(await repo.findOne({ where: where, select: { id: true } }));
  }

  private async getClaim(
    userId: number,
  ): Promise<FirstPurchaseGiftClaim | null> {
    return this.claimRepo.findOne({ where: { userId } });
  }

  async getPublicConfig() {
    const settings = await this.ensureSettings();
    const active = this.isLive(settings);

    return {
      data: {
        active,
        title: settings.title,
        description: settings.description,
        discountPercent: Number(settings.discountPercent),
        popupEnabled: active && settings.popupEnabled,
        announcementEnabled: active && settings.announcementEnabled,
        popupFrequency: settings.popupFrequency,
      },
    };
  }

  async getEligibility(
    userId?: number,
  ): Promise<{ data: FirstPurchaseGiftEligibility }> {
    const settings = await this.ensureSettings();
    const publicConfig = {
      discountPercent: Number(settings.discountPercent),
      title: settings.title,
      description: settings.description,
      stackWithDiscountCodes: settings.stackWithDiscountCodes,
    };

    if (!userId) {
      return {
        data: {
          authenticated: false,
          eligible: false,
          reason: 'guest',
          config: this.isLive(settings) ? publicConfig : null,
        },
      };
    }

    if (!this.isLive(settings)) {
      return {
        data: {
          authenticated: true,
          eligible: false,
          reason: 'inactive',
          config: null,
        },
      };
    }

    if (await this.hasSuccessfulWebsiteOrder(userId)) {
      return {
        data: {
          authenticated: true,
          eligible: false,
          reason: 'already_purchased',
          config: publicConfig,
        },
      };
    }

    const claim = await this.getClaim(userId);
    if (claim?.status === 'redeemed') {
      return {
        data: {
          authenticated: true,
          eligible: false,
          reason: 'redeemed',
          config: publicConfig,
        },
      };
    }
    if (
      claim?.status === 'reserved' &&
      claim.reservedUntil &&
      claim.reservedUntil > new Date()
    ) {
      // اگر سفارش مربوطه دیگر در انتظار پرداخت نیست، رزرو منقضی منموده است
      const order = await this.orderRepo.findOne({
        where: { id: claim.orderId },
        select: { id: true, status: true },
      });
      if (!order || order.status !== OrderStatus.PENDING) {
        await this.claimRepo.update(claim.id, {
          status: 'released',
          reservedUntil: null,
        });
        return {
          data: {
            authenticated: true,
            eligible: true,
            reason: 'eligible',
            config: publicConfig,
          },
        };
      }
      return {
        data: {
          authenticated: true,
          eligible: false,
          reason: 'reserved',
          config: publicConfig,
        },
      };
    }

    return {
      data: {
        authenticated: true,
        eligible: true,
        reason: 'eligible',
        config: publicConfig,
      },
    };
  }

  async getAdminSettings() {
    const settings = await this.ensureSettings();
    const [eligibleRows, usageRows] = await Promise.all([
      this.settingsRepo.query(
        `SELECT COUNT(*) AS count
         FROM \`user\` u
         WHERE NOT EXISTS (
           SELECT 1 FROM \`order\` o
           WHERE o.user_id = u.id AND o.status IN ('paid', 'shipped', 'delivered')
         )
         AND NOT EXISTS (
           SELECT 1 FROM first_purchase_gift_claims c
           WHERE c.user_id = u.id
             AND (c.status = 'redeemed'
               OR (c.status = 'reserved' AND c.reserved_until > UTC_TIMESTAMP()))
         )`,
      ),
      this.settingsRepo.query(
        `SELECT COUNT(DISTINCT c.user_id) AS usedCustomers,
                COUNT(*) AS ordersGenerated,
                COALESCE(SUM(c.discount_amount), 0) AS totalDiscountValue,
                COALESCE(SUM(o.finalPrice), 0) AS revenueGenerated
         FROM first_purchase_gift_claims c
         INNER JOIN \`order\` o ON o.id = c.order_id
         WHERE c.status = 'redeemed'`,
      ),
    ]);

    const usage = usageRows?.[0] ?? {};
    return {
      data: {
        ...settings,
        discountPercent: Number(settings.discountPercent),
        currentlyActive: this.isLive(settings),
        analytics: {
          eligibleCustomers: this.isLive(settings)
            ? Number(eligibleRows?.[0]?.count ?? 0)
            : 0,
          usedCustomers: Number(usage.usedCustomers ?? 0),
          ordersGenerated: Number(usage.ordersGenerated ?? 0),
          totalDiscountValue: Number(usage.totalDiscountValue ?? 0),
          revenueGenerated: Number(usage.revenueGenerated ?? 0),
        },
      },
    };
  }

  async updateSettings(dto: UpdateFirstPurchaseGiftDto) {
    const settings = await this.ensureSettings();
    const nextStart =
      dto.startsAt === undefined
        ? settings.startsAt
        : dto.startsAt === null
          ? null
          : new Date(dto.startsAt);
    const nextEnd =
      dto.endsAt === undefined
        ? settings.endsAt
        : dto.endsAt === null
          ? null
          : new Date(dto.endsAt);

    if (nextStart && nextEnd && nextEnd <= nextStart) {
      throw new BadRequestException('تاریخ پایان باید بعد از تاریخ شروع باشد.');
    }
    if (dto.title !== undefined && !dto.title.trim()) {
      throw new BadRequestException('عنوان هدیه نمی‌تواند خالی باشد.');
    }
    if (dto.description !== undefined && !dto.description.trim()) {
      throw new BadRequestException('توضیحات هدیه نمی‌تواند خالی باشد.');
    }

    Object.assign(settings, {
      ...dto,
      startsAt: nextStart,
      endsAt: nextEnd,
      title: dto.title?.trim() ?? settings.title,
      description: dto.description?.trim() ?? settings.description,
    });
    const saved = await this.settingsRepo.save(settings);
    return {
      data: {
        ...saved,
        discountPercent: Number(saved.discountPercent),
        currentlyActive: this.isLive(saved),
      },
    };
  }

  async getDiscountConfigForUser(userId: number) {
    const settings = await this.ensureSettings();
    const eligibility = await this.getEligibility(userId);
    return {
      settings,
      eligible: eligibility.data.eligible,
      reason: eligibility.data.reason,
    };
  }

  async reserveInTransaction(
    manager: EntityManager,
    userId: number,
    orderId: number,
    discountPercent: number,
    discountAmount: number,
    pricingOptions: {
      stackWithDiscountCodes: boolean;
      stackWithSalePrices: boolean;
      usedDiscountCode: boolean;
    },
  ): Promise<void> {
    // Serializes simultaneous checkout attempts for the same authenticated account.
    const user = await manager.findOne(User, {
      where: { id: userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!user) throw new NotFoundException('کاربر سفارش یافت نشد.');

    const settings = await manager.findOne(FirstPurchaseGiftSettings, {
      where: { id: 1 },
      lock: { mode: 'pessimistic_read' },
    });
    if (
      !this.isLive(settings) ||
      Number(settings.discountPercent) !== Number(discountPercent) ||
      settings.stackWithDiscountCodes !==
        pricingOptions.stackWithDiscountCodes ||
      settings.stackWithSalePrices !== pricingOptions.stackWithSalePrices ||
      (pricingOptions.usedDiscountCode && !settings.stackWithDiscountCodes)
    ) {
      throw new BadRequestException(
        'تنظیمات هدیه تغییر کرده است؛ لطفاً مبلغ سفارش را دوباره بررسی کنید.',
      );
    }

    if (await this.hasSuccessfulWebsiteOrder(userId, undefined, manager)) {
      throw new BadRequestException(
        'هدیه اولین خرید فقط برای اولین سفارش آنلاین قابل استفاده است.',
      );
    }

    const claimRepo = manager.getRepository(FirstPurchaseGiftClaim);
    const existing = await claimRepo.findOne({
      where: { userId },
      lock: { mode: 'pessimistic_write' },
    });
    const now = new Date();
    if (existing?.status === 'redeemed') {
      throw new BadRequestException('هدیه اولین خرید قبلاً استفاده شده است.');
    }
    if (
      existing?.status === 'reserved' &&
      existing.reservedUntil &&
      existing.reservedUntil > now
    ) {
      throw new BadRequestException(
        'یک سفارش دیگر با هدیه اولین خرید در انتظار پرداخت است.',
      );
    }

    const values = {
      orderId,
      status: 'reserved' as const,
      discountPercent,
      discountAmount,
      reservedUntil: new Date(now.getTime() + RESERVATION_TTL_MS),
      redeemedAt: null,
    };
    if (existing) {
      Object.assign(existing, values);
      await claimRepo.save(existing);
    } else {
      await claimRepo.save(claimRepo.create({ userId, ...values }));
    }
  }

  async assertClaimPayable(userId: number, orderId: number): Promise<void> {
    const settings = await this.ensureSettings();
    if (!this.isLive(settings)) {
      throw new BadRequestException(
        'هدیه اولین خرید در حال حاضر غیرفعال است؛ سفارش را بدون این هدیه دوباره ثبت کنید.',
      );
    }

    const claim = await this.claimRepo.findOne({ where: { userId } });
    if (
      !claim ||
      claim.orderId !== orderId ||
      claim.status !== 'reserved' ||
      !claim.reservedUntil ||
      claim.reservedUntil <= new Date()
    ) {
      throw new BadRequestException(
        'رزرو هدیه اولین خرید منقضی یا نامعتبر شده است؛ سفارش را دوباره ثبت کنید.',
      );
    }
    if (Number(claim.discountPercent) !== Number(settings.discountPercent)) {
      throw new BadRequestException(
        'درصد هدیه تغییر کرده است؛ لطفاً سفارش را دوباره ثبت کنید.',
      );
    }
    if (await this.hasSuccessfulWebsiteOrder(userId, orderId)) {
      throw new BadRequestException(
        'پس از یک خرید آنلاین موفق، هدیه اولین خرید قابل استفاده نیست.',
      );
    }

    claim.reservedUntil = new Date(Date.now() + RESERVATION_TTL_MS);
    await this.claimRepo.save(claim);
  }

  async redeemInTransaction(
    manager: EntityManager,
    userId: number,
    order: Order,
  ): Promise<void> {
    const claimRepo = manager.getRepository(FirstPurchaseGiftClaim);
    const claim = await claimRepo.findOne({
      where: { userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !claim ||
      claim.orderId !== order.id ||
      claim.status !== 'reserved' ||
      !claim.reservedUntil ||
      claim.reservedUntil <= new Date()
    ) {
      throw new BadRequestException(
        'رزرو هدیه اولین خرید معتبر نیست؛ پرداخت سفارش متوقف شد.',
      );
    }
    if (await this.hasSuccessfulWebsiteOrder(userId, order.id, manager)) {
      throw new BadRequestException(
        'یک خرید آنلاین دیگر ثبت شده و هدیه این سفارش دیگر قابل استفاده نیست.',
      );
    }

    claim.status = 'redeemed';
    claim.redeemedAt = new Date();
    claim.reservedUntil = null;
    claim.discountAmount = Number(order.firstPurchaseGiftDiscount ?? 0);
    await claimRepo.save(claim);
  }

  async releaseOrderReservation(
    manager: EntityManager,
    orderId: number,
  ): Promise<void> {
    await manager
      .getRepository(FirstPurchaseGiftClaim)
      .createQueryBuilder()
      .update()
      .set({ status: 'released', reservedUntil: null })
      .where('order_id = :orderId AND status = :status', {
        orderId,
        status: 'reserved',
      })
      .execute();
  }

  async releaseOtherReservationsForPaidOrder(
    manager: EntityManager,
    userId: number,
    paidOrderId: number,
  ): Promise<void> {
    await manager
      .getRepository(FirstPurchaseGiftClaim)
      .createQueryBuilder()
      .update()
      .set({ status: 'released', reservedUntil: null })
      .where(
        'user_id = :userId AND order_id != :paidOrderId AND status = :status',
        { userId, paidOrderId, status: 'reserved' },
      )
      .execute();
  }
}
