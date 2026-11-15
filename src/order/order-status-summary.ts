/**
 * شمارشِ صریحِ سفارش‌ها بر اساس وضعیت.
 *
 * چرا این فایل جدا شده است:
 * آمارِ داشبورد قبلاً با چند کوئریِ جداگانه ساخته می‌شد که در آن‌ها فقط
 * `cancelled` و `delivered` به‌صورت دقیق شمرده می‌شدند و بقیه در یک سطلِ
 * کلیِ «در جریان» جمع می‌شدند (`Not(In([CANCELLED, DELIVERED]))`). سطلِ کلی
 * یعنی سمتِ کلاینت نمی‌تواند بفهمد چند سفارش واقعاً «در انتظار پرداخت»
 * است و هر تغییری در وضعیت‌ها می‌تواند شمارش‌ها را از هم جدا کند.
 *
 * قواعد این ماژول:
 * ۱. وضعیت‌ها صریحاً و با تساویِ دقیق شمرده می‌شوند؛
 * ۲. وضعیتِ ناشناس (مقدار خالی یا وضعیتی که بعداً اضافه شده) در سطلِ
 *    `unknown` می‌رود و **هرگز** «تحویل شده» یا «لغو شده» حساب نمی‌شود؛
 * ۳. هیچ چیزی از روی نبودِ مقدار یا truthy بودن حدس زده نمی‌شود.
 */

import { OrderStatus } from './entities/order.entity';

export interface OrderStatusCounts {
  /** کل سفارش‌ها (با احتساب وضعیت‌های ناشناس) */
  total: number;
  /** در انتظار پرداخت */
  awaitingPayment: number;
  /** پرداخت شده (در حال آماده‌سازی) */
  processing: number;
  /** ارسال شده */
  shipped: number;
  /** تحویل شده — فقط وضعیتِ دقیقِ `delivered` */
  delivered: number;
  /** لغو شده — فقط وضعیتِ دقیقِ `cancelled` */
  cancelled: number;
  /** وضعیت‌های ناشناس یا جدید */
  unknown: number;
  /** در جریان: در انتظار پرداخت + پرداخت‌شده + ارسال‌شده */
  inProgress: number;
}

/** مقدارِ وضعیتی که از یک کوئریِ group-by می‌آید */
export interface OrderStatusCountRow {
  status?: unknown;
  count?: unknown;
}

export function emptyOrderStatusCounts(): OrderStatusCounts {
  return {
    total: 0,
    awaitingPayment: 0,
    processing: 0,
    shipped: 0,
    delivered: 0,
    cancelled: 0,
    unknown: 0,
    inProgress: 0,
  };
}

/**
 * تبدیل امنِ مقدارِ شمارش.
 *
 * در خروجیِ `getRawMany` مقدارِ COUNT معمولاً رشته است (`'2'`)؛ رشته، عدد،
 * `null` و مقدارِ نامعتبر همگی به یک عددِ صحیحِ نامنفی تبدیل می‌شوند و هرگز
 * استثنا نمی‌سازند.
 */
function toCount(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;

  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric < 0) return 0;

  return Math.floor(numeric);
}

/**
 * ساختِ آمار از خروجیِ یک کوئریِ `GROUP BY status`.
 *
 * مثال (گزارشِ مشتری): دو سفارش `pending` و یک سفارش `cancelled`
 * ⇒ `{ total: 3, awaitingPayment: 2, delivered: 0, cancelled: 1 }`.
 */
export function summarizeOrderStatusCounts(
  rows: readonly OrderStatusCountRow[] | null | undefined,
): OrderStatusCounts {
  const counts = emptyOrderStatusCounts();

  for (const row of rows ?? []) {
    const count = toCount(row?.count);

    if (count === 0) continue;

    switch (row?.status) {
      case OrderStatus.PENDING:
        counts.awaitingPayment += count;
        break;
      case OrderStatus.PAID:
        counts.processing += count;
        break;
      case OrderStatus.SHIPPED:
        counts.shipped += count;
        break;
      case OrderStatus.DELIVERED:
        counts.delivered += count;
        break;
      case OrderStatus.CANCELLED:
        counts.cancelled += count;
        break;
      default:
        // وضعیتِ ناشناس: شمرده می‌شود اما نه به‌عنوان تحویل‌شده/لغو‌شده
        counts.unknown += count;
        break;
    }
  }

  counts.total =
    counts.awaitingPayment +
    counts.processing +
    counts.shipped +
    counts.delivered +
    counts.cancelled +
    counts.unknown;

  counts.inProgress =
    counts.awaitingPayment + counts.processing + counts.shipped;

  return counts;
}
