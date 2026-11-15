import { OrderStatus } from './entities/order.entity';
import {
  emptyOrderStatusCounts,
  summarizeOrderStatusCounts,
} from './order-status-summary';

/**
 * تست‌های شمارشِ وضعیت سفارش.
 *
 * سناریوی واقعیِ گزارش‌شده: مشتری دو سفارش «در انتظار پرداخت» و یک سفارش
 * «لغو شده» دارد و هیچ سفارش تحویل‌شده‌ای ندارد؛ داشبورد نباید عددِ
 * «تحویل شده» را ۱ نشان دهد.
 */

describe('summarizeOrderStatusCounts', () => {
  it('counts the reported case: 2 awaiting payment + 1 cancelled ⇒ 0 delivered', () => {
    const counts = summarizeOrderStatusCounts([
      { status: OrderStatus.PENDING, count: '2' },
      { status: OrderStatus.CANCELLED, count: '1' },
    ]);

    expect(counts).toEqual({
      total: 3,
      awaitingPayment: 2,
      processing: 0,
      shipped: 0,
      delivered: 0,
      cancelled: 1,
      unknown: 0,
      inProgress: 2,
    });
  });

  it('counts every real status in its own bucket', () => {
    const counts = summarizeOrderStatusCounts([
      { status: OrderStatus.PENDING, count: 1 },
      { status: OrderStatus.PAID, count: 1 },
      { status: OrderStatus.SHIPPED, count: 1 },
      { status: OrderStatus.DELIVERED, count: 1 },
      { status: OrderStatus.CANCELLED, count: 1 },
    ]);

    expect(counts.awaitingPayment).toBe(1);
    expect(counts.processing).toBe(1);
    expect(counts.shipped).toBe(1);
    expect(counts.delivered).toBe(1);
    expect(counts.cancelled).toBe(1);
    expect(counts.total).toBe(5);
    expect(counts.inProgress).toBe(3);
  });

  it('never counts cancelled or awaiting-payment orders as delivered', () => {
    const counts = summarizeOrderStatusCounts([
      { status: OrderStatus.PENDING, count: 5 },
      { status: OrderStatus.CANCELLED, count: 7 },
    ]);

    expect(counts.delivered).toBe(0);
  });

  it('puts unknown or empty statuses in a separate bucket instead of guessing', () => {
    const counts = summarizeOrderStatusCounts([
      { status: 'delivered_by_hand', count: '3' },
      { status: null, count: '1' },
      { status: undefined, count: '2' },
      { status: OrderStatus.DELIVERED, count: '4' },
    ]);

    expect(counts.unknown).toBe(6);
    expect(counts.delivered).toBe(4);
    expect(counts.total).toBe(10);
    // وضعیت ناشناس «در جریان» نیست تا عدد کارت «در جریان» گمراه‌کننده نشود
    expect(counts.inProgress).toBe(0);
  });

  it('handles string counts coming from raw group-by queries', () => {
    const counts = summarizeOrderStatusCounts([
      { status: OrderStatus.DELIVERED, count: '12' },
    ]);

    expect(counts.delivered).toBe(12);
    expect(counts.total).toBe(12);
  });

  it('ignores invalid, negative and missing counts safely', () => {
    const counts = summarizeOrderStatusCounts([
      { status: OrderStatus.DELIVERED, count: 'not-a-number' },
      { status: OrderStatus.DELIVERED, count: -5 },
      { status: OrderStatus.PENDING },
      { status: OrderStatus.PENDING, count: null },
      { status: OrderStatus.PAID, count: 2.7 },
    ]);

    expect(counts.delivered).toBe(0);
    expect(counts.awaitingPayment).toBe(0);
    expect(counts.processing).toBe(2);
    expect(counts.total).toBe(2);
  });

  it('returns zeros for no rows at all', () => {
    expect(summarizeOrderStatusCounts([])).toEqual(emptyOrderStatusCounts());
    expect(summarizeOrderStatusCounts(null)).toEqual(emptyOrderStatusCounts());
    expect(summarizeOrderStatusCounts(undefined)).toEqual(
      emptyOrderStatusCounts(),
    );
    expect(summarizeOrderStatusCounts([]).total).toBe(0);
  });
});
