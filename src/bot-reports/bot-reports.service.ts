import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Role } from 'src/common/enum/role.enum';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import {
  Payment,
  PaymentPurpose,
  PaymentStatus,
} from 'src/payment/entities/payment.entity';
import { Product } from 'src/products/entities/product.entity';
import { Variant } from 'src/products/entities/variant.entity';
import { User } from 'src/users/entities/user.entity';
import {
  WalletTransaction,
  WalletTransactionStatus,
  WalletTransactionType,
} from 'src/wallet/entities/wallet-transaction.entity';
import { Brackets, In, Repository, SelectQueryBuilder } from 'typeorm';

import { buildUtf8Csv } from './bot-csv.util';
import {
  BOT_REPORTS_CURRENCY,
  BOT_REPORTS_CURRENCY_LABEL,
  BOT_REPORTS_TIMEZONE,
  BotOrderDetailDto,
  BotReportsReader,
  CsvExportResult,
  CustomerSummary,
  DailySalesPointDto,
  DateRange,
  InventoryCategoryFilter,
  InventoryItemDto,
  InventorySummaryDto,
  LowStockReport,
  OrdersTodaySummaryDto,
  PaginatedInventoryDto,
  PaginatedOrdersDto,
  SalesSummary,
} from './bot-reports.contract';
import { BotSettingsService } from './bot-settings.service';
import {
  formatTehranDateTimeFa,
  parseDateOnlyUtc,
  toRangeBounds,
  toTehranWallClockIso,
} from './bot-time.util';

/** وضعیت‌های سفارش که پرداخت موفقِ فعال و معتبر محسوب می‌شوند */
const PAID_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

/** وضعیت‌های تراکنش درگاه که نشان‌دهندهٔ پرداخت تاییدشده‌اند */
const CONFIRMED_PAYMENT_STATUSES: PaymentStatus[] = [
  PaymentStatus.SUCCESS,
  PaymentStatus.VERIFIED,
  PaymentStatus.SETTLED,
];

const LOW_STOCK_MAX_ITEMS = 500;
const EXPORT_BATCH_SIZE = 500;

@Injectable()
export class BotReportsService implements BotReportsReader {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,

    @InjectRepository(Variant)
    private readonly variantRepo: Repository<Variant>,

    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,

    @InjectRepository(WalletTransaction)
    private readonly walletTxRepo: Repository<WalletTransaction>,

    private readonly settingsService: BotSettingsService,
  ) {}

  /* ====================================================================== */
  /* ۱. بخش سفارش‌ها: خلاصهٔ امروز، فهرست صفحه‌بندی‌شده و جزئیات سفارش      */
  /* ====================================================================== */

  async getOrdersTodaySummary(date: string): Promise<OrdersTodaySummaryDto> {
    const { start, endExclusive } = toRangeBounds({ from: date, to: date });

    const statusRows = await this.orderRepo
      .createQueryBuilder('order')
      .select('order.status', 'status')
      .addSelect('COUNT(order.id)', 'count')
      .where('order.createdAt >= :start', { start })
      .andWhere('order.createdAt < :endExclusive', { endExclusive })
      .andWhere("order.orderNumber NOT LIKE 'TEST-%'")
      .groupBy('order.status')
      .getRawMany<{ status: string; count: string | number }>();

    const counts: Record<string, number> = {
      [OrderStatus.PENDING]: 0,
      [OrderStatus.PAID]: 0,
      [OrderStatus.SHIPPED]: 0,
      [OrderStatus.DELIVERED]: 0,
      [OrderStatus.CANCELLED]: 0,
    };

    for (const row of statusRows) {
      const key = String(row.status ?? '').toLowerCase();

      if (key in counts) {
        counts[key] = toCount(row.count);
      }
    }

    const refundedTodayCount = await this.countCancelledPaidOrdersInBounds(
      start,
      endExclusive,
    );

    const totalOrders =
      counts[OrderStatus.PENDING] +
      counts[OrderStatus.PAID] +
      counts[OrderStatus.SHIPPED] +
      counts[OrderStatus.DELIVERED] +
      counts[OrderStatus.CANCELLED];

    return {
      date,
      timezone: BOT_REPORTS_TIMEZONE,
      totalOrders,
      categories: {
        pending: counts[OrderStatus.PENDING],
        paid: counts[OrderStatus.PAID],
        shipped: counts[OrderStatus.SHIPPED],
        delivered: counts[OrderStatus.DELIVERED],
        cancelled: counts[OrderStatus.CANCELLED],
        refundedOrCancelledAfterPayment: refundedTodayCount,
      },
      statusDefinitions: {
        pending: 'جدید / در انتظار پرداخت (status = pending)',
        paid: 'پرداخت‌شده و در انتظار پردازش/ارسال (status = paid)',
        shipped: 'تحویل‌شده به پست/پیک و در مسیر ارسال (status = shipped)',
        delivered: 'تحویل‌شده و تکمیل‌شده (status = delivered)',
        cancelled: 'لغوشده (status = cancelled)',
        refundedNote:
          'وضعیت مجزای مرجوعی در OrderStatus وجود ندارد؛ سفارش‌های لغوشده‌ای که پرداخت درگاه یا عودت کیف‌پول داشته‌اند جداگانه شمارش می‌شوند.',
      },
      generatedAt: new Date().toISOString(),
    };
  }

  async listOrders(input: {
    page: number;
    limit: number;
    status?: string;
    from?: string;
    to?: string;
  }): Promise<PaginatedOrdersDto> {
    const page = Math.max(1, Math.trunc(input.page) || 1);
    const limit = Math.max(1, Math.min(20, Math.trunc(input.limit) || 10));

    const qb = this.orderRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .where("order.orderNumber NOT LIKE 'TEST-%'");

    if (input.status) {
      qb.andWhere('order.status = :status', { status: input.status });
    }

    if (input.from && input.to) {
      const { start, endExclusive } = toRangeBounds({
        from: input.from,
        to: input.to,
      });
      qb.andWhere('order.createdAt >= :start', { start }).andWhere(
        'order.createdAt < :endExclusive',
        { endExclusive },
      );
    }

    qb.orderBy('order.createdAt', 'DESC')
      .addOrderBy('order.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [orders, total] = await qb.getManyAndCount();

    return {
      items: orders.map(order => ({
        orderNumber: order.orderNumber,
        status: order.status,
        createdAt:
          toTehranWallClockIso(order.createdAt) ??
          order.createdAt.toISOString(),
        updatedAt:
          toTehranWallClockIso(order.updatedAt) ??
          toTehranWallClockIso(order.createdAt) ??
          order.createdAt.toISOString(),
        finalPrice: toAmount(order.finalPrice),
        itemsCount: (order.items ?? []).reduce(
          (sum, item) => sum + (Number(item.quantity) || 0),
          0,
        ),
        currency: BOT_REPORTS_CURRENCY,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      },
      filters: {
        status: input.status ?? null,
        from: input.from ?? null,
        to: input.to ?? null,
      },
      currency: BOT_REPORTS_CURRENCY,
      timezone: BOT_REPORTS_TIMEZONE,
    };
  }

  async getOrderDetail(
    orderNumber: string,
    options: { canViewCustomer: boolean; includeCustomer: boolean },
  ): Promise<BotOrderDetailDto | null> {
    const relations: Record<string, unknown> = {
      items: {
        variant: {
          product: true,
          color: true,
          size: true,
        },
      },
    };

    if (options.canViewCustomer) {
      relations.user = true;
      relations.address = {
        province: true,
        city: true,
      };
    }

    const order = await this.orderRepo.findOne({
      where: { orderNumber },
      relations,
    });

    if (!order) {
      return null;
    }

    const [gatewayPaidAmount, refundedAmount] = await Promise.all([
      this.sumConfirmedGatewayPaymentsToman(order.id),
      this.getOrderWalletRefundToman(order.id),
    ]);

    const items = (order.items ?? []).map(item => {
      const quantity = Number(item.quantity) || 0;
      const unitPrice = toAmount(item.price);
      const rawOriginal =
        item.originalPrice != null ? toAmount(item.originalPrice) : null;
      const lineTotal =
        item.totalPrice != null && Number(item.totalPrice) > 0
          ? toAmount(item.totalPrice)
          : toAmount(unitPrice * quantity);

      return {
        productName: item.variant?.product?.title ?? 'کالای حذف‌شده',
        variant: toVariantLabel(
          item.variant?.color?.name,
          item.variant?.size?.name,
        ),
        color: item.variant?.color?.name?.trim() || null,
        size: item.variant?.size?.name?.trim() || null,
        sku: item.variant?.sku ?? null,
        quantity,
        originalUnitPrice:
          rawOriginal !== null && rawOriginal > unitPrice ? rawOriginal : null,
        unitPrice,
        lineTotal,
      };
    });

    const computedItemsSubtotal = items.reduce(
      (sum, item) =>
        sum + (item.originalUnitPrice ?? item.unitPrice) * item.quantity,
      0,
    );
    const finalPrice = toAmount(order.finalPrice);
    const itemsSubtotal =
      order.totalPrice != null && Number(order.totalPrice) > 0
        ? toAmount(order.totalPrice)
        : computedItemsSubtotal > 0
          ? toAmount(computedItemsSubtotal)
          : finalPrice;

    const canViewCustomer = Boolean(options.canViewCustomer);
    const customerSummary =
      canViewCustomer && order.user
        ? {
            fullName: order.user.fullName,
            province: order.address?.province?.name ?? null,
            city: order.address?.city?.name ?? null,
          }
        : null;

    const customer =
      canViewCustomer && options.includeCustomer && order.user
        ? {
            fullName: order.user.fullName,
            phone: order.user.phone,
            province: order.address?.province?.name ?? null,
            city: order.address?.city?.name ?? null,
            address: order.address?.address ?? null,
            postalCode: order.address?.postalCode ?? null,
          }
        : null;

    return {
      orderNumber: order.orderNumber,
      status: order.status,
      createdAt:
        toTehranWallClockIso(order.createdAt) ?? order.createdAt.toISOString(),
      updatedAt:
        toTehranWallClockIso(order.updatedAt ?? order.createdAt) ??
        order.createdAt.toISOString(),
      currency: BOT_REPORTS_CURRENCY,
      shippingMethod: order.shippingMethod ?? null,
      itemsSubtotal,
      saleDiscount: toAmount(order.saleDiscount),
      discount: toAmount(order.discount),
      shippingCost: toAmount(order.shippingCost),
      walletPayment: toAmount(order.walletPayment),
      gatewayPaidAmount,
      refundedAmount,
      finalPrice,
      total: finalPrice,
      items,
      canViewCustomer,
      customerAccessDenied: !canViewCustomer,
      customerSummary,
      customer,
    };
  }

  /* ====================================================================== */
  /* ۲. بخش گزارش فروش و خروجی CSV تفصیلی                                   */
  /* ====================================================================== */

  async getSalesSummary(range: DateRange): Promise<SalesSummary> {
    const { start, endExclusive } = toRangeBounds(range);

    // ۱. جمع وضعیت‌های سفارش در بازه (بدون سفارش‌های تست)
    const statusRows = await this.orderRepo
      .createQueryBuilder('order')
      .select('order.status', 'status')
      .addSelect('COUNT(order.id)', 'count')
      .where('order.createdAt >= :start', { start })
      .andWhere('order.createdAt < :endExclusive', { endExclusive })
      .andWhere("order.orderNumber NOT LIKE 'TEST-%'")
      .groupBy('order.status')
      .getRawMany<{ status: string; count: string | number }>();

    let pendingOrders = 0;
    let cancelledOrders = 0;
    let statusTotalCount = 0;

    for (const row of statusRows ?? []) {
      const cnt = toCount(row.count);
      const rowStatus = row.status as OrderStatus;
      statusTotalCount += cnt;
      if (rowStatus === OrderStatus.PENDING) pendingOrders = cnt;
      if (rowStatus === OrderStatus.CANCELLED) cancelledOrders = cnt;
    }

    // ۲. تجمیع سفارش‌های پرداخت موفقِ فعال (paid / shipped / delivered)
    const paidRow = await this.orderRepo
      .createQueryBuilder('order')
      .select('COUNT(order.id)', 'paidOrders')
      .addSelect(
        'COALESCE(SUM(CASE WHEN order.totalPrice > 0 THEN order.totalPrice ELSE GREATEST(0, order.finalPrice - COALESCE(order.shippingCost, 0) + COALESCE(order.discount, 0)) END), 0)',
        'grossItems',
      )
      .addSelect('COALESCE(SUM(order.discount), 0)', 'discounts')
      .addSelect('COALESCE(SUM(order.shippingCost), 0)', 'shippingTotal')
      .addSelect('COALESCE(SUM(order.finalPrice), 0)', 'finalPaidTotal')
      .where('order.createdAt >= :start', { start })
      .andWhere('order.createdAt < :endExclusive', { endExclusive })
      .andWhere("order.orderNumber NOT LIKE 'TEST-%'")
      .andWhere('order.status IN (:...statuses)', {
        statuses: PAID_ORDER_STATUSES,
      })
      .getRawOne<{
        paidOrders: string | number;
        grossItems?: string | number;
        grossSales?: string | number;
        discounts?: string | number;
        shippingTotal?: string | number;
        finalPaidTotal?: string | number;
      }>();

    const paidOrders = toCount(paidRow?.paidOrders);
    const activeGrossItems = toAmount(
      paidRow?.grossItems ?? paidRow?.grossSales ?? 0,
    );
    const activeDiscounts = toAmount(paidRow?.discounts ?? 0);
    const shippingTotal = toAmount(paidRow?.shippingTotal ?? 0);
    const finalPaidTotal = toAmount(
      paidRow?.finalPaidTotal ??
        activeGrossItems - activeDiscounts + shippingTotal,
    );

    // ۳. سفارش‌هایی که واقعاً پرداخت/کسر کیف‌پول داشته‌اند ولی بعداً لغو شده‌اند (بازپرداخت/مرجوعی)
    const refundedSummary = await this.aggregateCancelledPaidOrdersInBounds(
      start,
      endExclusive,
    );

    const grossSales = toAmount(
      activeGrossItems + refundedSummary.cancelledGrossItems,
    );
    const discounts = toAmount(
      activeDiscounts + refundedSummary.cancelledDiscounts,
    );
    const refunds = toAmount(refundedSummary.refundedNetItems);
    const netSales = Math.max(0, toAmount(grossSales - discounts - refunds));

    const totalOrders =
      statusTotalCount > 0
        ? statusTotalCount
        : paidOrders + pendingOrders + cancelledOrders;

    const rangeDays = computeDaysInRange(range.from, range.to);
    const dailyBreakdown =
      rangeDays <= 31
        ? await this.loadDailySalesBreakdown(start, endExclusive)
        : [];

    return {
      from: range.from,
      to: range.to,
      timezone: BOT_REPORTS_TIMEZONE,
      currency: BOT_REPORTS_CURRENCY,
      currencyLabel: BOT_REPORTS_CURRENCY_LABEL,
      totalOrders,
      paidOrders,
      pendingOrders,
      cancelledOrders,
      refundedOrders: refundedSummary.count,
      grossSales,
      discounts,
      refunds,
      netSales,
      shippingTotal,
      finalPaidTotal,
      averageOrderValue: paidOrders > 0 ? toAmount(netSales / paidOrders) : 0,
      averageFinalOrderValue:
        paidOrders > 0 ? toAmount(finalPaidTotal / paidOrders) : 0,
      dailyBreakdown,
      generatedAt: new Date().toISOString(),
    };
  }

  async exportSalesCsv(range: DateRange): Promise<CsvExportResult> {
    const { start, endExclusive } = toRangeBounds(range);
    const generatedAt = new Date();
    const filename = `zoppini-sales-${range.from}-to-${range.to}.csv`;
    const rows: Array<Array<unknown>> = [];

    let lastId = 0;
    let rowIndex = 0;

    while (true) {
      const batch = await this.orderRepo
        .createQueryBuilder('order')
        .leftJoinAndSelect('order.items', 'items')
        .where('order.createdAt >= :start', { start })
        .andWhere('order.createdAt < :endExclusive', { endExclusive })
        .andWhere("order.orderNumber NOT LIKE 'TEST-%'")
        .andWhere('order.id > :lastId', { lastId })
        .orderBy('order.id', 'ASC')
        .take(EXPORT_BATCH_SIZE)
        .getMany();

      if (!batch.length) {
        break;
      }

      const batchIds = batch.map(o => o.id);
      const [gatewayMap, walletRefundMap] = await Promise.all([
        this.mapGatewayPaidByOrderIds(batchIds),
        this.mapWalletRefundsByOrderIds(batchIds),
      ]);

      for (const order of batch) {
        rowIndex += 1;
        lastId = order.id;

        const itemsCount = (order.items ?? []).reduce(
          (sum, item) => sum + (Number(item.quantity) || 0),
          0,
        );
        const isPaidActive = PAID_ORDER_STATUSES.includes(order.status);
        const grossItems =
          Number(order.totalPrice) > 0
            ? toAmount(order.totalPrice)
            : Math.max(
                0,
                toAmount(order.finalPrice) -
                  toAmount(order.shippingCost) +
                  toAmount(order.discount),
              );
        const discount = toAmount(order.discount);
        const shippingCost = toAmount(order.shippingCost);
        const walletPayment = toAmount(order.walletPayment);
        const gatewayPaid = gatewayMap.get(order.id) ?? 0;
        const walletRefund = walletRefundMap.get(order.id) ?? 0;
        const wasPaidAndCancelled =
          order.status === OrderStatus.CANCELLED &&
          (gatewayPaid > 0 || walletRefund > 0);
        const refundAmount = wasPaidAndCancelled
          ? Math.max(walletRefund, Math.max(0, grossItems - discount))
          : 0;
        const netRevenue = isPaidActive
          ? Math.max(0, grossItems - discount)
          : 0;

        rows.push([
          rowIndex,
          order.orderNumber,
          toTehranWallClockIso(order.createdAt) ?? '',
          statusFaLabel(order.status),
          order.status,
          itemsCount,
          grossItems,
          discount,
          shippingCost,
          walletPayment,
          gatewayPaid,
          refundAmount,
          netRevenue,
          toAmount(order.finalPrice),
          BOT_REPORTS_CURRENCY_LABEL,
        ]);
      }

      if (batch.length < EXPORT_BATCH_SIZE) {
        break;
      }
    }

    const reportTimeFa = formatTehranDateTimeFa(generatedAt);
    const csvContent = buildUtf8Csv({
      metadataCells: [
        `نام فایل: ${filename}`,
        `بازه گزارش: ${range.from} تا ${range.to}`,
        `زمان تولید گزارش: ${reportTimeFa} (${BOT_REPORTS_TIMEZONE})`,
        `واحد مبالغ: ${BOT_REPORTS_CURRENCY_LABEL} (${BOT_REPORTS_CURRENCY})`,
        `تعداد کل رکوردها: ${rows.length}`,
      ],
      headers: [
        'ردیف',
        'شماره سفارش',
        'تاریخ ثبت (Asia/Tehran)',
        'وضعیت فارسی',
        'کد وضعیت',
        'تعداد کل اقلام',
        'بهای ناخالص اقلام (تومان)',
        'تخفیف کل (تومان)',
        'هزینه ارسال (تومان)',
        'پرداخت کیف‌پول (تومان)',
        'پرداخت درگاه موفق (تومان)',
        'بازپرداخت/لغو پس از پرداخت (تومان)',
        'فروش خالص اقلام محاسبه‌شده (تومان)',
        'مبلغ نهایی سفارش (تومان)',
        'واحد پول',
      ],
      rows,
    });

    return {
      filename,
      totalRecords: rows.length,
      generatedAt: generatedAt.toISOString(),
      csvContent,
    };
  }

  /* ====================================================================== */
  /* ۳. بخش موجودی کالا: خلاصه، فهرست صفحه‌بندی، جست‌وجو و خروجی CSV        */
  /* ====================================================================== */

  async getInventorySummary(): Promise<InventorySummaryDto> {
    const threshold = await this.settingsService.getLowStockThreshold();
    const sync = await this.settingsService.getSyncHealthDto();

    const [stockAgg, totalProducts] = await Promise.all([
      this.variantRepo
        .createQueryBuilder('variant')
        .select('COUNT(variant.id)', 'totalVariants')
        .addSelect(
          'COALESCE(SUM(CASE WHEN variant.stock <= 0 THEN 1 ELSE 0 END), 0)',
          'outOfStockVariants',
        )
        .addSelect(
          'COALESCE(SUM(CASE WHEN variant.stock >= 1 AND variant.stock <= :threshold THEN 1 ELSE 0 END), 0)',
          'lowStockVariants',
        )
        .addSelect(
          'COALESCE(SUM(CASE WHEN variant.stock > :threshold THEN 1 ELSE 0 END), 0)',
          'inStockVariants',
        )
        .setParameter('threshold', threshold)
        .getRawOne<{
          totalVariants: string | number;
          outOfStockVariants: string | number;
          lowStockVariants: string | number;
          inStockVariants: string | number;
        }>(),
      typeof this.productRepo?.count === 'function'
        ? this.productRepo.count()
        : Promise.resolve(0),
    ]);

    return {
      countingUnit: 'variant',
      stockField: 'variant.stock',
      threshold,
      totalProducts: toCount(totalProducts),
      totalVariants: toCount(stockAgg?.totalVariants),
      outOfStockVariants: toCount(stockAgg?.outOfStockVariants),
      lowStockVariants: toCount(stockAgg?.lowStockVariants),
      inStockVariants: toCount(stockAgg?.inStockVariants),
      sync,
      generatedAt: new Date().toISOString(),
    };
  }

  async listInventory(input: {
    category: InventoryCategoryFilter;
    query?: string;
    threshold?: number;
    page: number;
    limit: number;
  }): Promise<PaginatedInventoryDto> {
    const threshold =
      input.threshold !== undefined
        ? input.threshold
        : await this.settingsService.getLowStockThreshold();
    const page = Math.max(1, Math.trunc(input.page) || 1);
    const limit = Math.max(1, Math.min(20, Math.trunc(input.limit) || 15));
    const cleanQuery = sanitizeInventorySearch(input.query);

    const qb = this.buildInventoryQueryBuilder({
      category: input.category,
      threshold,
      query: cleanQuery,
    });

    qb.orderBy('variant.stock', 'ASC')
      .addOrderBy('product.title', 'ASC')
      .addOrderBy('variant.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const [variants, total] = await qb.getManyAndCount();
    const sync = await this.settingsService.getSyncHealthDto();

    return {
      countingUnit: 'variant',
      category: input.category,
      query: cleanQuery || null,
      threshold,
      items: variants.map(v => mapVariantToInventoryItem(v)),
      pagination: {
        page,
        limit,
        total,
        totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      },
      sync,
      currency: BOT_REPORTS_CURRENCY,
    };
  }

  async exportInventoryCsv(input: {
    category: InventoryCategoryFilter;
    query?: string;
    threshold?: number;
  }): Promise<CsvExportResult> {
    const threshold =
      input.threshold !== undefined
        ? input.threshold
        : await this.settingsService.getLowStockThreshold();
    const cleanQuery = sanitizeInventorySearch(input.query);
    const generatedAt = new Date();
    const dateStamp = generatedAt.toISOString().slice(0, 10);
    const filename = `zoppini-inventory-${input.category}-${dateStamp}.csv`;

    const rows: Array<Array<unknown>> = [];
    let offset = 0;
    let rowNumber = 0;

    while (true) {
      const qb = this.buildInventoryQueryBuilder({
        category: input.category,
        threshold,
        query: cleanQuery,
      });

      const batch = await qb
        .orderBy('variant.stock', 'ASC')
        .addOrderBy('variant.id', 'ASC')
        .skip(offset)
        .take(EXPORT_BATCH_SIZE)
        .getMany();

      if (!batch.length) {
        break;
      }

      for (const variant of batch) {
        rowNumber += 1;
        const item = mapVariantToInventoryItem(variant);
        const stockStateLabel =
          item.stock <= 0
            ? 'ناموجود (۰)'
            : item.stock <= threshold
              ? `کم‌موجود (≤ ${threshold})`
              : 'موجود';

        rows.push([
          rowNumber,
          item.productCode ?? '',
          item.productName,
          item.variant ?? '',
          item.color ?? '',
          item.size ?? '',
          item.sku ?? '',
          item.stock,
          stockStateLabel,
          item.price,
          item.updatedAt ?? '',
        ]);
      }

      offset += batch.length;

      if (batch.length < EXPORT_BATCH_SIZE) {
        break;
      }
    }

    const reportTimeFa = formatTehranDateTimeFa(generatedAt);
    const categoryLabel =
      input.category === 'out'
        ? 'ناموجود (موجودی صفر)'
        : input.category === 'low'
          ? `کم‌موجود (۱ تا ${threshold})`
          : input.category === 'in'
            ? `موجود (بالای ${threshold})`
            : 'همهٔ واریانت‌ها';

    const csvContent = buildUtf8Csv({
      metadataCells: [
        `نام فایل: ${filename}`,
        `دسته گزارش: ${categoryLabel}`,
        cleanQuery ? `جست‌وجو: ${cleanQuery}` : 'جست‌وجو: همه',
        `معیار شمارش: واریانت کالا (variant.stock)`,
        `زمان تولید گزارش: ${reportTimeFa} (${BOT_REPORTS_TIMEZONE})`,
        `تعداد کل رکوردها: ${rows.length}`,
      ],
      headers: [
        'ردیف',
        'کد محصول',
        'نام محصول',
        'واریانت (رنگ / سایز)',
        'رنگ',
        'سایز',
        'SKU',
        'موجودی قابل فروش آنلاین (عدد)',
        'وضعیت موجودی',
        'قیمت واحد (تومان)',
        'آخرین بروزرسانی واریانت (Asia/Tehran)',
      ],
      rows,
    });

    return {
      filename,
      totalRecords: rows.length,
      generatedAt: generatedAt.toISOString(),
      csvContent,
    };
  }

  async getLowStock(input: { threshold: number }): Promise<LowStockReport> {
    const { threshold } = input;

    const variants = await this.variantRepo
      .createQueryBuilder('variant')
      .leftJoinAndSelect('variant.product', 'product')
      .leftJoinAndSelect('variant.color', 'color')
      .leftJoinAndSelect('variant.size', 'size')
      .where('variant.stock <= :threshold', { threshold })
      .orderBy('variant.stock', 'ASC')
      .addOrderBy('product.title', 'ASC')
      .take(LOW_STOCK_MAX_ITEMS)
      .getMany();

    const sync = await this.settingsService.getSyncHealthDto();

    return {
      threshold,
      countingUnit: 'variant',
      inventorySyncedAt: sync.lastSucceededAt ?? sync.fallbackVariantUpdatedAt,
      sync,
      items: variants.map(variant => ({
        productName: variant.product?.title ?? `محصول ${variant.productId}`,
        variant: toVariantLabel(variant.color?.name, variant.size?.name),
        sku: variant.sku ?? null,
        stock: Number(variant.stock) || 0,
      })),
    };
  }

  /* ====================================================================== */
  /* ۴. بخش خلاصهٔ مشتری‌ها                                                 */
  /* ====================================================================== */

  async getCustomerSummary(range: DateRange): Promise<CustomerSummary> {
    const { start, endExclusive } = toRangeBounds(range);

    const newCustomers = await this.userRepo
      .createQueryBuilder('user')
      .where('user.createdAt >= :start', { start })
      .andWhere('user.createdAt < :endExclusive', { endExclusive })
      .andWhere(`FIND_IN_SET('${Role.Admin}', user.roles) = 0`)
      .getCount();

    const activeRow =
      typeof this.orderRepo?.createQueryBuilder === 'function'
        ? await this.orderRepo
            .createQueryBuilder('order')
            .select('COUNT(DISTINCT order.user_id)', 'activeBuyers')
            .where('order.createdAt >= :start', { start })
            .andWhere('order.createdAt < :endExclusive', { endExclusive })
            .andWhere("order.orderNumber NOT LIKE 'TEST-%'")
            .andWhere('order.status IN (:...statuses)', {
              statuses: PAID_ORDER_STATUSES,
            })
            .getRawOne<{ activeBuyers?: string | number }>()
        : undefined;

    const repeatRow = await this.orderRepo
      .createQueryBuilder('order')
      .innerJoin(
        Order,
        'previousOrder',
        'previousOrder.user_id = order.user_id ' +
          'AND previousOrder.created_at < :rangeStart ' +
          'AND previousOrder.status IN (:...previousStatuses)',
      )
      .select('COUNT(DISTINCT order.user_id)', 'repeatCustomers')
      .where('order.createdAt >= :start', { start })
      .andWhere('order.createdAt < :endExclusive', { endExclusive })
      .andWhere("order.orderNumber NOT LIKE 'TEST-%'")
      .andWhere('order.status IN (:...statuses)', {
        statuses: PAID_ORDER_STATUSES,
      })
      .setParameters({
        rangeStart: start,
        previousStatuses: PAID_ORDER_STATUSES,
      })
      .getRawOne<{ repeatCustomers: string | number }>();

    const repeatCustomers = toCount(repeatRow?.repeatCustomers);
    const activeBuyers = Math.max(
      repeatCustomers,
      toCount(activeRow?.activeBuyers),
    );
    const firstTimeBuyers = Math.max(0, activeBuyers - repeatCustomers);

    return {
      from: range.from,
      to: range.to,
      timezone: BOT_REPORTS_TIMEZONE,
      newCustomers,
      activeBuyers,
      repeatCustomers,
      firstTimeBuyers,
      generatedAt: new Date().toISOString(),
    };
  }

  /* ====================================================================== */
  /* متدهای کمکی خصوصی                                                      */
  /* ====================================================================== */

  private buildInventoryQueryBuilder(input: {
    category: InventoryCategoryFilter;
    threshold: number;
    query: string;
  }): SelectQueryBuilder<Variant> {
    const qb = this.variantRepo
      .createQueryBuilder('variant')
      .leftJoinAndSelect('variant.product', 'product')
      .leftJoinAndSelect('variant.color', 'color')
      .leftJoinAndSelect('variant.size', 'size');

    switch (input.category) {
      case 'out':
        qb.where('variant.stock <= 0');
        break;
      case 'low':
        qb.where('variant.stock >= 1 AND variant.stock <= :threshold', {
          threshold: input.threshold,
        });
        break;
      case 'in':
        qb.where('variant.stock > :threshold', {
          threshold: input.threshold,
        });
        break;
      case 'all':
      default:
        qb.where('1 = 1');
        break;
    }

    if (input.query) {
      const escapedPattern = `%${escapeLikeWildcards(input.query)}%`;
      const arabicVariant = `%${escapeLikeWildcards(
        input.query.replace(/ی/g, 'ي').replace(/ک/g, 'ك'),
      )}%`;

      qb.andWhere(
        new Brackets(sub => {
          sub
            .where('product.title LIKE :q', { q: escapedPattern })
            .orWhere('product.title LIKE :qAr', { qAr: arabicVariant })
            .orWhere('product.productCode LIKE :q', { q: escapedPattern })
            .orWhere('variant.sku LIKE :q', { q: escapedPattern })
            .orWhere('color.name LIKE :q', { q: escapedPattern })
            .orWhere('size.name LIKE :q', { q: escapedPattern });
        }),
      );
    }

    return qb;
  }

  private async sumConfirmedGatewayPaymentsToman(
    orderId: number,
  ): Promise<number> {
    if (typeof this.paymentRepo?.find !== 'function') {
      return 0;
    }

    const payments = await this.paymentRepo.find({
      where: {
        orderId,
        purpose: PaymentPurpose.ORDER,
        status: In(CONFIRMED_PAYMENT_STATUSES),
      },
      select: { id: true, amount: true },
    });

    const totalRials = payments.reduce(
      (sum, payment) => sum + (Number(payment.amount) || 0),
      0,
    );

    // مبالغ جدول payments درگاه به ریال ذخیره می‌شوند؛ تبدیل دقیق به تومان
    return toAmount(totalRials / 10);
  }

  private async getOrderWalletRefundToman(orderId: number): Promise<number> {
    if (typeof this.walletTxRepo?.findOne !== 'function') {
      return 0;
    }

    const tx = await this.walletTxRepo.findOne({
      where: {
        transactionKey: `wallet-order-${orderId}-refund`,
        type: WalletTransactionType.REFUND,
        status: WalletTransactionStatus.SUCCESS,
      },
      select: { id: true, amount: true },
    });

    return tx ? toAmount(tx.amount) : 0;
  }

  private async countCancelledPaidOrdersInBounds(
    start: string,
    endExclusive: string,
  ): Promise<number> {
    const summary = await this.aggregateCancelledPaidOrdersInBounds(
      start,
      endExclusive,
    );

    return summary.count;
  }

  private async aggregateCancelledPaidOrdersInBounds(
    start: string,
    endExclusive: string,
  ): Promise<{
    count: number;
    cancelledGrossItems: number;
    cancelledDiscounts: number;
    refundedNetItems: number;
  }> {
    if (typeof this.orderRepo?.createQueryBuilder !== 'function') {
      return {
        count: 0,
        cancelledGrossItems: 0,
        cancelledDiscounts: 0,
        refundedNetItems: 0,
      };
    }

    const qb = this.orderRepo.createQueryBuilder('order');

    if (typeof qb.getMany !== 'function') {
      return {
        count: 0,
        cancelledGrossItems: 0,
        cancelledDiscounts: 0,
        refundedNetItems: 0,
      };
    }

    const cancelledOrders = await qb
      .where('order.createdAt >= :start', { start })
      .andWhere('order.createdAt < :endExclusive', { endExclusive })
      .andWhere("order.orderNumber NOT LIKE 'TEST-%'")
      .andWhere('order.status = :cancelled', {
        cancelled: OrderStatus.CANCELLED,
      })
      .getMany();

    if (!cancelledOrders?.length) {
      return {
        count: 0,
        cancelledGrossItems: 0,
        cancelledDiscounts: 0,
        refundedNetItems: 0,
      };
    }

    const orderIds = cancelledOrders.map(o => o.id);
    const [gatewayMap, walletRefundMap] = await Promise.all([
      this.mapGatewayPaidByOrderIds(orderIds),
      this.mapWalletRefundsByOrderIds(orderIds),
    ]);

    let count = 0;
    let cancelledGrossItems = 0;
    let cancelledDiscounts = 0;
    let refundedNetItems = 0;

    for (const order of cancelledOrders) {
      const gatewayPaid = gatewayMap.get(order.id) ?? 0;
      const walletRefund = walletRefundMap.get(order.id) ?? 0;

      if (gatewayPaid <= 0 && walletRefund <= 0) {
        // سفارش لغوشدهٔ پرداخت‌نشده (پرداخت ناموفق یا انصراف قبل از پرداخت) — نباید وارد فروش یا عودت شود
        continue;
      }

      count += 1;
      const gross =
        Number(order.totalPrice) > 0
          ? toAmount(order.totalPrice)
          : Math.max(
              0,
              toAmount(order.finalPrice) -
                toAmount(order.shippingCost) +
                toAmount(order.discount),
            );
      const disc = toAmount(order.discount);
      const netItems = Math.max(0, gross - disc);

      cancelledGrossItems += gross;
      cancelledDiscounts += disc;
      refundedNetItems += netItems;
    }

    return {
      count,
      cancelledGrossItems: toAmount(cancelledGrossItems),
      cancelledDiscounts: toAmount(cancelledDiscounts),
      refundedNetItems: toAmount(refundedNetItems),
    };
  }

  private async mapGatewayPaidByOrderIds(
    orderIds: number[],
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();

    if (!orderIds.length || typeof this.paymentRepo?.find !== 'function') {
      return map;
    }

    const payments = await this.paymentRepo.find({
      where: {
        orderId: In(orderIds),
        purpose: PaymentPurpose.ORDER,
        status: In(CONFIRMED_PAYMENT_STATUSES),
      },
      select: { id: true, orderId: true, amount: true },
    });

    for (const p of payments) {
      if (p.orderId == null) continue;
      const prev = map.get(p.orderId) ?? 0;
      map.set(p.orderId, toAmount(prev + (Number(p.amount) || 0) / 10));
    }

    return map;
  }

  private async mapWalletRefundsByOrderIds(
    orderIds: number[],
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();

    if (!orderIds.length || typeof this.walletTxRepo?.find !== 'function') {
      return map;
    }

    const keys = orderIds.map(id => `wallet-order-${id}-refund`);
    const txs = await this.walletTxRepo.find({
      where: {
        transactionKey: In(keys),
        type: WalletTransactionType.REFUND,
        status: WalletTransactionStatus.SUCCESS,
      },
      select: { id: true, transactionKey: true, amount: true },
    });

    for (const tx of txs) {
      const match = tx.transactionKey.match(/^wallet-order-(\d+)-refund$/);
      if (!match) continue;
      const orderId = Number(match[1]);
      map.set(orderId, toAmount(tx.amount));
    }

    return map;
  }

  private async loadDailySalesBreakdown(
    start: string,
    endExclusive: string,
  ): Promise<DailySalesPointDto[]> {
    const qb = this.orderRepo.createQueryBuilder('order');

    if (
      typeof qb.getRawMany !== 'function' ||
      typeof qb.groupBy !== 'function'
    ) {
      return [];
    }

    const rows = await qb
      .select('DATE_FORMAT(order.createdAt, "%Y-%m-%d")', 'date')
      .addSelect('COUNT(order.id)', 'paidOrders')
      .addSelect(
        'COALESCE(SUM(GREATEST(0, (CASE WHEN order.totalPrice > 0 THEN order.totalPrice ELSE GREATEST(0, order.finalPrice - COALESCE(order.shippingCost, 0) + COALESCE(order.discount, 0)) END) - COALESCE(order.discount, 0))), 0)',
        'netSales',
      )
      .addSelect('COALESCE(SUM(order.finalPrice), 0)', 'finalPaidTotal')
      .where('order.createdAt >= :start', { start })
      .andWhere('order.createdAt < :endExclusive', { endExclusive })
      .andWhere("order.orderNumber NOT LIKE 'TEST-%'")
      .andWhere('order.status IN (:...statuses)', {
        statuses: PAID_ORDER_STATUSES,
      })
      .groupBy('DATE_FORMAT(order.createdAt, "%Y-%m-%d")')
      .orderBy('date', 'ASC')
      .getRawMany<{
        date: string;
        paidOrders: string | number;
        netSales: string | number;
        finalPaidTotal: string | number;
      }>();

    return (rows ?? []).map(row => ({
      date: String(row.date),
      paidOrders: toCount(row.paidOrders),
      netSales: toAmount(row.netSales),
      finalPaidTotal: toAmount(row.finalPaidTotal),
    }));
  }
}

/* ======================================================================== */
/* توابع خالص کمکی                                                          */
/* ======================================================================== */

function toAmount(value: unknown): number {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return 0;
  }

  return Math.round(amount * 100) / 100;
}

function toCount(value: unknown): number {
  const count = Number(value);

  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

function toVariantLabel(
  colorName?: string | null,
  sizeName?: string | null,
): string | null {
  const parts = [colorName, sizeName]
    .map(part => String(part ?? '').trim())
    .filter(Boolean);

  return parts.length ? parts.join(' / ') : null;
}

function mapVariantToInventoryItem(variant: Variant): InventoryItemDto {
  return {
    variantId: variant.id,
    productId: variant.productId,
    productCode: variant.product?.productCode ?? null,
    productName: variant.product?.title ?? `محصول ${variant.productId}`,
    variant: toVariantLabel(variant.color?.name, variant.size?.name),
    color: variant.color?.name?.trim() || null,
    size: variant.size?.name?.trim() || null,
    sku: variant.sku ?? null,
    stock: Number(variant.stock) || 0,
    price: toAmount(variant.price),
    updatedAt: toTehranWallClockIso(variant.updatedAt),
  };
}

export function sanitizeInventorySearch(raw?: string): string {
  if (!raw) {
    return '';
  }

  return String(raw)
    .trim()
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/\u0643/g, 'ک')
    .replace(/[\u064a\u0649]/g, 'ی')
    .replace(/\p{Cc}/gu, '')
    .slice(0, 100)
    .trim();
}

function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, char => `\\${char}`);
}

function computeDaysInRange(from: string, to: string): number {
  const startMs = parseDateOnlyUtc(from);
  const endMs = parseDateOnlyUtc(to);

  if (startMs === null || endMs === null || endMs < startMs) {
    return 0;
  }

  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

function statusFaLabel(status: string): string {
  switch (status as OrderStatus) {
    case OrderStatus.PENDING:
      return 'در انتظار پرداخت';
    case OrderStatus.PAID:
      return 'پرداخت‌شده';
    case OrderStatus.SHIPPED:
      return 'ارسال‌شده';
    case OrderStatus.DELIVERED:
      return 'تحویل‌شده';
    case OrderStatus.CANCELLED:
      return 'لغوشده';
    default:
      return status;
  }
}
