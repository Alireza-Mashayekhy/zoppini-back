import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import {
  Payment,
  PaymentPurpose,
  PaymentStatus,
} from 'src/payment/entities/payment.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from 'src/wallet/entities/wallet-transaction.entity';
import { Repository } from 'typeorm';

import {
  BOT_ORDER_CURRENCY,
  BOT_ORDER_CURRENCY_UNIT,
  BOT_PAYMENT_CURRENCY_UNIT,
  BOT_TIME_ZONE,
} from '../bot.constants';
import { TehranDateRange } from '../utils/tehran-date.util';

/**
 * وضعیت‌هایی که در نسخه‌ی اول «فروش محقق‌شده» در نظر گرفته می‌شوند.
 *
 * منطق سایت: پس از پرداخت موفق، Order.status به PAID تغییر می‌کند
 * (order.service.ts → confirmOrderPayment). SHIPPED و DELIVERED هم
 * مراحل بعد از پرداخت هستند. PENDING و CANCELLED در فروش نیستند.
 */
const SALES_ORDER_STATUSES = [
  OrderStatus.PAID,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class BotSalesService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,

    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,

    @InjectRepository(WalletTransaction)
    private readonly walletTransactionRepo: Repository<WalletTransaction>,
  ) {}

  private async sumOrdersByStatus(
    range: TehranDateRange,
    statuses: OrderStatus[],
  ): Promise<{ orderCount: number; amount: number }> {
    const raw = await this.orderRepo
      .createQueryBuilder('o')
      .select('COUNT(o.id)', 'orderCount')
      .addSelect('COALESCE(SUM(o.finalPrice), 0)', 'amount')
      .where('o.status IN (:...statuses)', { statuses })
      .andWhere('o.createdAt >= :from AND o.createdAt < :to', {
        from: range.fromUtc,
        to: range.toExclusiveUtc,
      })
      .getRawOne<{ orderCount: string; amount: string }>();

    return {
      orderCount: toNumber(raw?.orderCount),
      amount: roundMoney(toNumber(raw?.amount)),
    };
  }

  private async walletRefunds(
    range: TehranDateRange,
  ): Promise<{ transactionCount: number; amount: number }> {
    const raw = await this.walletTransactionRepo
      .createQueryBuilder('tx')
      .select('COUNT(tx.id)', 'transactionCount')
      .addSelect('COALESCE(SUM(tx.amount), 0)', 'amount')
      .where('tx.type = :type', {
        type: WalletTransactionType.REFUND,
      })
      .andWhere('tx.direction = :direction', {
        direction: WalletTransactionDirection.CREDIT,
      })
      .andWhere('tx.status = :status', {
        status: WalletTransactionStatus.SUCCESS,
      })
      .andWhere('tx.createdAt >= :from AND tx.createdAt < :to', {
        from: range.fromUtc,
        to: range.toExclusiveUtc,
      })
      .getRawOne<{ transactionCount: string; amount: string }>();

    return {
      transactionCount: toNumber(raw?.transactionCount),
      amount: roundMoney(toNumber(raw?.amount)),
    };
  }

  /**
   * سفارش‌هایی که پرداخت موفق دارند ولی وضعیت سفارش هنوز PENDING است.
   * این‌ها در «فروش» شمرده نمی‌شوند (چون تعریف فروش، وضعیت سفارش است)
   * اما پنهان هم نمی‌شوند و به‌عنوان ناسازگاری گزارش می‌شوند.
   */
  private async pendingOrdersWithSuccessfulPayment(
    range: TehranDateRange,
  ): Promise<number> {
    const raw = await this.paymentRepo
      .createQueryBuilder('p')
      .innerJoin(Order, 'ord', 'ord.id = p.orderId')
      .select('COUNT(DISTINCT p.orderId)', 'count')
      .where('p.purpose = :purpose', {
        purpose: PaymentPurpose.ORDER,
      })
      .andWhere('p.status IN (:...statuses)', {
        statuses: [PaymentStatus.SUCCESS, PaymentStatus.VERIFIED],
      })
      .andWhere('ord.status = :orderStatus', {
        orderStatus: OrderStatus.PENDING,
      })
      .andWhere('p.createdAt >= :from AND p.createdAt < :to', {
        from: range.fromUtc,
        to: range.toExclusiveUtc,
      })
      .getRawOne<{ count: string }>();

    return toNumber(raw?.count);
  }

  /**
   * سفارش‌های لغوشده‌ای که سابقه‌ی پرداخت موفق دارند.
   * کد فعلی فقط سهم کیف پول را برمی‌گرداند؛ برگشت وجه درگاه
   * به‌صورت خودکار و قابل‌ردیابی در این API ثبت نمی‌شود.
   */
  private async cancelledOrdersWithSuccessfulPayment(
    range: TehranDateRange,
  ): Promise<number> {
    const raw = await this.paymentRepo
      .createQueryBuilder('p')
      .innerJoin(Order, 'ord', 'ord.id = p.orderId')
      .select('COUNT(DISTINCT p.orderId)', 'count')
      .where('p.purpose = :purpose', {
        purpose: PaymentPurpose.ORDER,
      })
      .andWhere('p.status IN (:...statuses)', {
        statuses: [PaymentStatus.SUCCESS, PaymentStatus.VERIFIED],
      })
      .andWhere('ord.status = :orderStatus', {
        orderStatus: OrderStatus.CANCELLED,
      })
      .andWhere('p.createdAt >= :from AND p.createdAt < :to', {
        from: range.fromUtc,
        to: range.toExclusiveUtc,
      })
      .getRawOne<{ count: string }>();

    return toNumber(raw?.count);
  }

  async getSalesReport(range: TehranDateRange) {
    const [sales, cancellations, refunds, pendingMismatch, cancelledPaid] =
      await Promise.all([
        this.sumOrdersByStatus(range, SALES_ORDER_STATUSES),
        this.sumOrdersByStatus(range, [OrderStatus.CANCELLED]),
        this.walletRefunds(range),
        this.pendingOrdersWithSuccessfulPayment(range),
        this.cancelledOrdersWithSuccessfulPayment(range),
      ]);

    const averageOrderAmount =
      sales.orderCount > 0 ? roundMoney(sales.amount / sales.orderCount) : 0;

    return {
      range: {
        from: range.from,
        to: range.to,
        timeZone: BOT_TIME_ZONE,
        fromUtc: range.fromUtc.toISOString(),
        toExclusiveUtc: range.toExclusiveUtc.toISOString(),
        basis: 'order.createdAt',
      },
      sales: {
        orderCount: sales.orderCount,
        amount: sales.amount,
        averageOrderAmount,
      },
      cancellations: {
        orderCount: cancellations.orderCount,
        amount: cancellations.amount,
        // مبلغ سفارش لغوشده لزوماً پول پرداخت‌شده نیست.
        amountIsPaidRevenue: false,
      },
      refunds: {
        walletRefundTransactionCount: refunds.transactionCount,
        walletRefundAmount: refunds.amount,
        gatewayRefundsRecorded: false,
      },
      anomalies: {
        pendingOrdersWithSuccessfulPayment: pendingMismatch,
        cancelledOrdersWithSuccessfulPayment: cancelledPaid,
      },
      definitions: {
        salesStatuses: SALES_ORDER_STATUSES,
        cancellationStatus: OrderStatus.CANCELLED,
        amountField: 'order.finalPrice',
        amountIncludesShipping: true,
        netOfCancellationsOrRefunds: false,
        orderCurrency: BOT_ORDER_CURRENCY,
        orderCurrencyUnit: BOT_ORDER_CURRENCY_UNIT,
        paymentCurrencyUnit: BOT_PAYMENT_CURRENCY_UNIT,
        paidAtStored: false,
        note: 'گزارش بر اساس تاریخ ثبت سفارش است؛ زمان دقیق پرداخت در مدل سفارش ذخیره نمی‌شود. برگشت وجه درگاه در سامانه به‌صورت تراکنش مستقل ثبت نمی‌شود.',
      },
    };
  }
}
