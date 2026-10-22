import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Role } from 'src/common/enum/role.enum';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { Variant } from 'src/products/entities/variant.entity';
import { User } from 'src/users/entities/user.entity';
import { Repository } from 'typeorm';

import {
  BOT_REPORTS_CURRENCY,
  BotOrder,
  BotReportsReader,
  CustomerSummary,
  DateRange,
  LowStockReport,
  SalesSummary,
} from './bot-reports.contract';

/**
 * وضعیت‌هایی که «فروش قطعی» حساب می‌شوند: پرداخت موفق انجام شده است.
 * `pending` هنوز پرداخت نشده و `cancelled` لغو شده است؛ هیچ‌کدام فروش نیستند.
 */
const PAID_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

/** سقف تعداد واریانت‌های کم‌موجود که در یک پاسخ برمی‌گردد */
const LOW_STOCK_MAX_ITEMS = 500;

/** پسوند منطقهٔ زمانی ایران برای تاریخ‌های خروجی */
const TEHRAN_TIMEZONE_SUFFIX = '+03:30';

interface DateRangeBounds {
  /** شروع بازه به شکل `YYYY-MM-DD HH:mm:ss` (شامل) */
  start: string;
  /** پایان بازه به شکل `YYYY-MM-DD HH:mm:ss` (خارج از بازه؛ شروع روز بعد از `to`) */
  endExclusive: string;
}

/**
 * Adapter واقعی گزارش‌های ربات بله: پیاده‌سازی `BotReportsReader` روی
 * ریپازیتوری‌های سفارش، واریانت (موجودی) و کاربر. همهٔ کوئری‌ها فقط‌خواندنی‌اند
 * و خروجی دقیقاً به شکل قرارداد ساخته می‌شود (بدون دادهٔ شخصی مشتری).
 *
 * نکتهٔ منطقهٔ زمانی: مثل بقیهٔ پروژه (مثلاً `TorobService` و `ModaiService`)
 * فرض بر این است که تاریخ‌های دیتابیس «ساعت دیواری تهران» هستند؛ پس بازهٔ
 * روزانه مستقیم روی `created_at` فیلتر می‌شود و تبدیلی انجام نمی‌گیرد.
 */
@Injectable()
export class BotReportsService implements BotReportsReader {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,

    @InjectRepository(Variant)
    private readonly variantRepo: Repository<Variant>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async getSalesSummary(range: DateRange): Promise<SalesSummary> {
    const { start, endExclusive } = toRangeBounds(range);

    const row = await this.orderRepo
      .createQueryBuilder('order')
      .select('COUNT(order.id)', 'paidOrders')
      .addSelect('COALESCE(SUM(order.finalPrice), 0)', 'grossSales')
      .where('order.createdAt >= :start', { start })
      .andWhere('order.createdAt < :endExclusive', { endExclusive })
      .andWhere('order.status IN (:...statuses)', {
        statuses: PAID_ORDER_STATUSES,
      })
      .getRawOne<{
        paidOrders: string | number;
        grossSales: string | number;
      }>();

    const paidOrders = toCount(row?.paidOrders);
    const grossSales = toAmount(row?.grossSales);

    // در پروژه موجودیت refund و زمانِ لغو ثبت نمی‌شود (لغو فقط وضعیت سفارش
    // را عوض می‌کند و عودت سهم کیف پول است، نه برگشت وجه درگاه). پس عدد
    // قابل‌اتکایی برای «بازپرداخت در بازه» نداریم و صفر گزارش می‌شود تا
    // عدد ساختگی وارد گزارش مالی نشود؛ netSales فعلاً برابر grossSales است.
    const refunds = 0;
    const netSales = grossSales - refunds;

    return {
      from: range.from,
      to: range.to,
      timezone: 'Asia/Tehran',
      currency: BOT_REPORTS_CURRENCY,
      paidOrders,
      grossSales,
      refunds,
      netSales,
      averageOrderValue: paidOrders > 0 ? toAmount(netSales / paidOrders) : 0,
      generatedAt: new Date().toISOString(),
    };
  }

  async getLowStock(input: { threshold: number }): Promise<LowStockReport> {
    const { threshold } = input;

    // فیلد مرجع موجودی فروشگاه `variant.stock` است (همان فیلدی که هنگام
    // ثبت سفارش کم می‌شود)؛ `stockRetail`/`stockHadishMall` موجودی
    // شعبه‌های راهکاران‌اند و در فروش آنلاین استفاده نمی‌شوند.
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

    const syncRow = await this.variantRepo
      .createQueryBuilder('variant')
      .select('MAX(variant.updatedAt)', 'inventorySyncedAt')
      .getRawOne<{ inventorySyncedAt: string | Date | null }>();

    return {
      threshold,
      inventorySyncedAt: toTehranWallClockIso(syncRow?.inventorySyncedAt),
      items: variants.map(variant => ({
        productName: variant.product?.title ?? `محصول ${variant.productId}`,
        variant: toVariantLabel(variant.color?.name, variant.size?.name),
        sku: variant.sku ?? null,
        stock: Number(variant.stock) || 0,
      })),
    };
  }

  async getOrder(orderNumber: string): Promise<BotOrder | null> {
    const order = await this.orderRepo.findOne({
      where: { orderNumber },
      relations: {
        items: {
          variant: {
            product: true,
            color: true,
            size: true,
          },
        },
      },
    });

    if (!order) {
      return null;
    }

    // عمداً کاربر، آدرس، یادداشت و کد تخفیف لود/ارسال نمی‌شوند؛ ربات فقط
    // برای پیگیری وضعیت و اقلام سفارش است (رجوع به قرارداد).
    return {
      orderNumber: order.orderNumber,
      status: order.status,
      createdAt:
        toTehranWallClockIso(order.createdAt) ?? order.createdAt.toISOString(),
      currency: BOT_REPORTS_CURRENCY,
      total: toAmount(order.finalPrice),
      items: (order.items ?? []).map(item => ({
        productName: item.variant?.product?.title ?? 'کالای حذف‌شده',
        variant: toVariantLabel(
          item.variant?.color?.name,
          item.variant?.size?.name,
        ),
        quantity: Number(item.quantity) || 0,
        unitPrice: toAmount(item.price),
      })),
    };
  }

  async getCustomerSummary(range: DateRange): Promise<CustomerSummary> {
    const { start, endExclusive } = toRangeBounds(range);

    // roles به‌صورت simple-array (رشتهٔ جداشده با کاما) ذخیره می‌شود؛
    // FIND_IN_SET حساب‌های مدیر را از «مشتری جدید» کنار می‌گذارد.
    const newCustomers = await this.userRepo
      .createQueryBuilder('user')
      .where('user.createdAt >= :start', { start })
      .andWhere('user.createdAt < :endExclusive', { endExclusive })
      .andWhere(`FIND_IN_SET('${Role.Admin}', user.roles) = 0`)
      .getCount();

    // مشتری تکراری: در بازه خرید پرداخت‌شده دارد و قبل از بازه هم داشته است.
    // سلف‌جوین روی سفارش‌ها + COUNT(DISTINCT خریدار) هر مشتری را یک‌بار می‌شمارد.
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
      .andWhere('order.status IN (:...statuses)', {
        statuses: PAID_ORDER_STATUSES,
      })
      .setParameters({
        rangeStart: start,
        previousStatuses: PAID_ORDER_STATUSES,
      })
      .getRawOne<{ repeatCustomers: string | number }>();

    return {
      newCustomers,
      repeatCustomers: toCount(repeatRow?.repeatCustomers),
    };
  }
}

/** تبدیل بازهٔ `YYYY-MM-DD` به کران‌های ساعت دیواری برای شرط `>= start AND < end` */
function toRangeBounds(range: DateRange): DateRangeBounds {
  return {
    start: `${range.from} 00:00:00`,
    endExclusive: `${addDays(range.to, 1)} 00:00:00`,
  };
}

/** جمع‌زدن روز روی تاریخ `YYYY-MM-DD` بدون درگیری منطقهٔ زمانی (محاسبه روی UTC) */
function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));

  return utc.toISOString().slice(0, 10);
}

/** مبلغ دیتابیس (decimal به‌شکل رشته برمی‌گردد) به عدد با حداکثر دو رقم اعشار */
function toAmount(value: unknown): number {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return 0;
  }

  return Math.round(amount * 100) / 100;
}

/** شمارش دیتابیس (معمولاً رشته برمی‌گردد) به عدد صحیح نامنفی */
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

/**
 * تبدیل تاریخ دیتابیس به ISO با پسوند تهران، بر اساس «ساعت دیواری» ذخیره‌شده.
 *
 * اگر مقدار رشته باشد (`YYYY-MM-DD HH:mm:ss`) همان ارقام حفظ می‌شوند و اگر
 * `Date` باشد اجزای محلی آن خوانده می‌شود (درایور MySQL تاریخ را با منطقهٔ
 * زمانی محلی سرور می‌سازد، پس اجزای محلی همان ارقام ذخیره‌شده‌اند).
 */
function toTehranWallClockIso(
  value: string | Date | null | undefined,
): string | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }

    const pad = (part: number) => String(part).padStart(2, '0');

    return (
      `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` +
      `T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}` +
      TEHRAN_TIMEZONE_SUFFIX
    );
  }

  const match = String(value)
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);

  if (!match) {
    return null;
  }

  return `${match[1]}T${match[2]}${TEHRAN_TIMEZONE_SUFFIX}`;
}
