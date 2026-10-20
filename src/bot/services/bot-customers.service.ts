import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { User } from 'src/users/entities/user.entity';
import { Repository } from 'typeorm';

import { BOT_TIME_ZONE } from '../bot.constants';
import { TehranDateRange } from '../utils/tehran-date.util';

const SALES_ORDER_STATUSES = [
  OrderStatus.PAID,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class BotCustomersService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * فقط آمار تجمیعی؛ هیچ فهرست، نام، تلفن یا شناسه‌ی مشتری برنمی‌گردد.
   *
   * - «مشتری جدید»: خریدار موفقی که اولین سفارش موفقش داخل بازه است.
   * - «مشتری بازگشتی»: خریدار موفقی که قبل از بازه سفارش موفق داشته است.
   * - «ثبت‌نام جدید»: تعداد User.createdAt داخل بازه (مستقل از خرید).
   */
  async getCustomerReport(range: TehranDateRange) {
    const totalsRaw = await this.orderRepo
      .createQueryBuilder('o')
      .innerJoin('o.user', 'user')
      .select('COUNT(DISTINCT user.id)', 'buyerCount')
      .addSelect('COUNT(o.id)', 'orderCount')
      .addSelect('MIN(o.createdAt)', 'firstOrderAt')
      .addSelect('MAX(o.createdAt)', 'lastOrderAt')
      .where('o.status IN (:...statuses)', {
        statuses: SALES_ORDER_STATUSES,
      })
      .andWhere('o.createdAt >= :from AND o.createdAt < :to', {
        from: range.fromUtc,
        to: range.toExclusiveUtc,
      })
      .getRawOne<{
        buyerCount: string;
        orderCount: string;
        firstOrderAt: string | Date | null;
        lastOrderAt: string | Date | null;
      }>();

    const returningRaw = await this.orderRepo
      .createQueryBuilder('o')
      .innerJoin('o.user', 'user')
      .select('COUNT(DISTINCT user.id)', 'count')
      .where('o.status IN (:...statuses)', {
        statuses: SALES_ORDER_STATUSES,
      })
      .andWhere('o.createdAt >= :from AND o.createdAt < :to', {
        from: range.fromUtc,
        to: range.toExclusiveUtc,
      })
      .andWhere(qb => {
        const previousOrder = qb
          .subQuery()
          .select('1')
          .from(Order, 'previous')
          .where('previous.user_id = user.id')
          .andWhere('previous.status IN (:...previousStatuses)')
          .andWhere('previous.created_at < :rangeStart')
          .setParameter('previousStatuses', SALES_ORDER_STATUSES)
          .setParameter('rangeStart', range.fromUtc)
          .getQuery();

        return `EXISTS ${previousOrder}`;
      })
      .getRawOne<{ count: string }>();

    const registrationsRaw = await this.userRepo
      .createQueryBuilder('user')
      .select('COUNT(user.id)', 'count')
      .where('user.createdAt >= :from AND user.createdAt < :to', {
        from: range.fromUtc,
        to: range.toExclusiveUtc,
      })
      .getRawOne<{ count: string }>();

    const buyerCount = toNumber(totalsRaw?.buyerCount);
    const orderCount = toNumber(totalsRaw?.orderCount);
    const returningCustomers = Math.min(
      buyerCount,
      toNumber(returningRaw?.count),
    );
    const newCustomers = Math.max(0, buyerCount - returningCustomers);

    const firstOrderAt = totalsRaw?.firstOrderAt
      ? new Date(totalsRaw.firstOrderAt)
      : null;
    const lastOrderAt = totalsRaw?.lastOrderAt
      ? new Date(totalsRaw.lastOrderAt)
      : null;

    return {
      range: {
        from: range.from,
        to: range.to,
        timeZone: BOT_TIME_ZONE,
        fromUtc: range.fromUtc.toISOString(),
        toExclusiveUtc: range.toExclusiveUtc.toISOString(),
        basis: 'order.createdAt',
      },
      customers: {
        buyers: buyerCount,
        newCustomers,
        returningCustomers,
        newRegistrations: toNumber(registrationsRaw?.count),
        orders: orderCount,
        averageOrdersPerBuyer:
          buyerCount > 0 ? round(orderCount / buyerCount) : 0,
        firstOrderAt:
          firstOrderAt && !Number.isNaN(firstOrderAt.getTime())
            ? firstOrderAt.toISOString()
            : null,
        lastOrderAt:
          lastOrderAt && !Number.isNaN(lastOrderAt.getTime())
            ? lastOrderAt.toISOString()
            : null,
      },
      definitions: {
        newCustomer: 'خریداری که اولین سفارش موفقش داخل بازه بوده است',
        returningCustomer:
          'خریداری که قبل از شروع بازه حداقل یک سفارش موفق داشته است',
        registrationBasis: 'User.createdAt',
        salesStatuses: SALES_ORDER_STATUSES,
        note: 'فقط آمار تجمیعی است؛ فهرست مشتریان، نام، تلفن یا کد ملی برگردانده نمی‌شود.',
      },
    };
  }
}
