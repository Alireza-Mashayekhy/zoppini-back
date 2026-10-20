import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { Payment, PaymentStatus } from 'src/payment/entities/payment.entity';
import { In, Repository } from 'typeorm';

import {
  BOT_ORDER_CURRENCY,
  BOT_ORDER_CURRENCY_UNIT,
  BOT_PAYMENT_CURRENCY_UNIT,
} from '../bot.constants';
import { OrdersQueryDto } from '../dto/orders-query.dto';

const SALES_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.PAID,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
]);

const SUCCESSFUL_PAYMENT_STATUSES = [
  PaymentStatus.SUCCESS,
  PaymentStatus.VERIFIED,
];

type PaymentStatusView = 'paid' | 'unpaid' | 'cancelled' | 'review';

type PaymentMethodView = 'wallet' | 'gateway' | 'mixed' | 'unknown';

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * حتی نام مشتری به‌صورت کامل به تلگرام نمی‌رود.
 * فقط حرف اول برای این‌که مالک بتواند سفارش را تشخیص دهد.
 */
function maskCustomerName(fullName: string | null | undefined): string | null {
  const value = (fullName ?? '').trim();

  if (!value) {
    return null;
  }

  const firstCharacter = Array.from(value)[0];

  return firstCharacter ? `${firstCharacter}***` : null;
}

@Injectable()
export class BotOrdersService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,

    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
  ) {}

  private normalizeOrderNumber(orderNumber: string): string {
    const normalized = (orderNumber ?? '').trim();

    if (
      normalized.length < 4 ||
      normalized.length > 40 ||
      !/^[A-Za-z0-9-]+$/.test(normalized)
    ) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'شماره سفارش معتبر نیست.',
        error: 'Bad Request',
        code: 'INVALID_ORDER_NUMBER',
      });
    }

    return normalized;
  }

  async searchOrders(query: OrdersQueryDto) {
    const pattern = `%${this.normalizeOrderNumber(query.orderNumber)}%`;

    const [orders, total] = await this.orderRepo
      .createQueryBuilder('o')
      .leftJoin('o.user', 'user')
      .select([
        'o.id',
        'o.orderNumber',
        'o.status',
        'o.finalPrice',
        'o.createdAt',
      ])
      .addSelect(['user.id', 'user.fullName'])
      .where('o.orderNumber LIKE :pattern', { pattern })
      .orderBy('o.createdAt', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();

    const items = orders.map(order => ({
      orderNumber: order.orderNumber,
      status: order.status,
      createdAt: order.createdAt?.toISOString() ?? null,
      finalPrice: roundMoney(toNumber(order.finalPrice)),
      currency: BOT_ORDER_CURRENCY,
      currencyUnit: BOT_ORDER_CURRENCY_UNIT,
      customerNameMasked: maskCustomerName(order.user?.fullName),
      customerNameIsMasked: true,
    }));

    return {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
      search: {
        field: 'orderNumber',
        mode: 'partial',
        sensitiveDataExcluded: [
          'phone',
          'email',
          'nationalCode',
          'address',
          'paymentGatewayRaw',
        ],
      },
    };
  }

  async getOrderByNumber(orderNumber: string) {
    const normalized = this.normalizeOrderNumber(orderNumber);

    const order = await this.orderRepo.findOne({
      where: { orderNumber: normalized },
      relations: {
        user: true,
        items: {
          variant: {
            product: true,
            color: true,
            size: true,
          },
        },
      },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        totalPrice: true,
        shippingCost: true,
        discount: true,
        saleDiscount: true,
        walletPayment: true,
        finalPrice: true,
        user: {
          id: true,
          fullName: true,
        },
        items: {
          id: true,
          quantity: true,
          price: true,
          originalPrice: true,
          totalPrice: true,
          variant: {
            id: true,
            sku: true,
            price: true,
            stock: true,
            product: {
              id: true,
              title: true,
            },
            color: {
              id: true,
              name: true,
            },
            size: {
              id: true,
              name: true,
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'سفارش یافت نشد.',
        error: 'Not Found',
        code: 'ORDER_NOT_FOUND',
      });
    }

    const payments = await this.paymentRepo.find({
      where: {
        orderId: order.id,
        status: In(SUCCESSFUL_PAYMENT_STATUSES),
      },
      select: {
        id: true,
        amount: true,
        status: true,
        createdAt: true,
      },
      order: {
        createdAt: 'ASC',
      },
    });

    const finalPrice = roundMoney(toNumber(order.finalPrice));
    const walletPaidAmount = roundMoney(toNumber(order.walletPayment));
    const gatewayPaidAmount = roundMoney(
      payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0) / 10,
    );
    const successfulGatewayPaymentRecorded = payments.length > 0;

    let paymentStatus: PaymentStatusView;

    if (order.status === OrderStatus.CANCELLED) {
      paymentStatus = 'cancelled';
    } else if (
      successfulGatewayPaymentRecorded &&
      order.status === OrderStatus.PENDING
    ) {
      // پول گرفته شده ولی نهایی‌سازی سفارش انجام نشده؛ نیازمند بررسی.
      paymentStatus = 'review';
    } else if (
      successfulGatewayPaymentRecorded ||
      (finalPrice > 0 && walletPaidAmount >= finalPrice) ||
      SALES_ORDER_STATUSES.has(order.status)
    ) {
      paymentStatus = 'paid';
    } else {
      paymentStatus = 'unpaid';
    }

    let paymentMethod: PaymentMethodView = 'unknown';

    if (walletPaidAmount > 0 && gatewayPaidAmount > 0) {
      paymentMethod = 'mixed';
    } else if (gatewayPaidAmount > 0) {
      paymentMethod = 'gateway';
    } else if (finalPrice > 0 && walletPaidAmount >= finalPrice) {
      paymentMethod = 'wallet';
    }

    const items = (order.items ?? []).map(item => {
      const variant = item.variant;

      return {
        productTitle: variant?.product?.title ?? 'محصول حذف‌شده',
        sku: variant?.sku ?? null,
        color: variant?.color?.name ?? null,
        size: variant?.size?.name ?? null,
        quantity: Number(item.quantity ?? 0),
        unitPrice: roundMoney(toNumber(item.price)),
        originalUnitPrice:
          item.originalPrice === null || item.originalPrice === undefined
            ? null
            : roundMoney(toNumber(item.originalPrice)),
        lineTotal: roundMoney(toNumber(item.totalPrice)),
      };
    });

    const itemsSubtotal = roundMoney(
      items.reduce((sum, item) => sum + item.lineTotal, 0),
    );

    return {
      orderNumber: order.orderNumber,
      status: order.status,
      createdAt: order.createdAt?.toISOString() ?? null,
      updatedAt: order.updatedAt?.toISOString() ?? null,
      customer: {
        nameMasked: maskCustomerName(order.user?.fullName),
        nameIsMasked: true,
        note: 'نام کامل، تلفن، ایمیل، کد ملی و نشانی عمداً برگردانده نمی‌شوند.',
      },
      items,
      itemCount: items.length,
      totals: {
        itemsSubtotal,
        totalPrice: roundMoney(toNumber(order.totalPrice)),
        discount: roundMoney(toNumber(order.discount)),
        saleDiscount: roundMoney(toNumber(order.saleDiscount)),
        shippingCost: roundMoney(toNumber(order.shippingCost)),
        walletPayment: walletPaidAmount,
        finalPrice,
        currency: BOT_ORDER_CURRENCY,
        currencyUnit: BOT_ORDER_CURRENCY_UNIT,
      },
      payment: {
        status: paymentStatus,
        method: paymentMethod,
        successfulGatewayPaymentRecorded,
        gatewayPaidAmount,
        walletPaidAmount,
        paidAt: payments[0]?.createdAt?.toISOString() ?? null,
        storedPaymentAmountUnit: BOT_PAYMENT_CURRENCY_UNIT,
        note: 'مبلغ موفق درگاه در دیتابیس ریال است و در این پاسخ به تومان تبدیل شده است. اطلاعات خام درگاه برگردانده نمی‌شود.',
      },
    };
  }
}
