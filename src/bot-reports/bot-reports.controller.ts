import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RawResponse } from 'src/common/decorators/raw-response.decorator';

import type { BotReportsReader, DateRange } from './bot-reports.contract';
import { BOT_REPORTS_READER } from './bot-reports.contract';
import { BotServiceKeyGuard } from './bot-service-key.guard';

/** حداکثر طول بازهٔ گزارش (روز)؛ برای جلوگیری از کوئری‌های سنگین تصادفی */
const MAX_RANGE_DAYS = 366;

/** بررسی شکل و واقعی‌بودن تاریخ‌های بازه و ساختن `DateRange` قرارداد */
function dateRange(from?: string, to?: string): DateRange {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  if (!from || !to || !datePattern.test(from) || !datePattern.test(to)) {
    throw new BadRequestException(
      'from and to must be valid YYYY-MM-DD dates, with from <= to.',
    );
  }

  const fromTime = parseDateOnly(from);
  const toTime = parseDateOnly(to);

  if (fromTime == null || toTime == null || fromTime > toTime) {
    throw new BadRequestException(
      'from and to must be valid YYYY-MM-DD dates, with from <= to.',
    );
  }

  const rangeDays = (toTime - fromTime) / 86_400_000 + 1;

  if (rangeDays > MAX_RANGE_DAYS) {
    throw new BadRequestException(
      `date range must not exceed ${MAX_RANGE_DAYS} days.`,
    );
  }

  return { from, to, timezone: 'Asia/Tehran' };
}

/** تجزیهٔ `YYYY-MM-DD` به زمان UTC؛ برای تاریخ‌های غیرواقعی (مثل ۳۰ فوریه) `null` */
function parseDateOnly(value: string): number | null {
  const [year, month, day] = value.split('-').map(Number);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);

  const isRealDate =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;

  return isRealDate ? time : null;
}

/**
 * API فقط‌خواندنی گزارش‌های ربات مدیریتی بله.
 *
 * آدرس نهایی (با پیشوند global `api`): `/api/bot/v1/...`
 *
 * خروجی خام برگردانده می‌شود (`@RawResponse`) تا ResponseInterceptor عمومی
 * آن را داخل `{ status, message, data }` نپیچد؛ ربات بدنهٔ دقیق قرارداد
 * (`BotReportsReader`) را انتظار دارد. همهٔ مسیرها با secret سرویس‌به‌سرویس
 * (`BotServiceKeyGuard`) محافظت می‌شوند و محدودیت نرخ سخت‌گیرانه‌تری از
 * حالت عمومی دارند، چون مصرف‌کننده فقط یک ربات با کلیک دستی مدیرهاست.
 */
@Controller('bot/v1')
@UseGuards(BotServiceKeyGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@RawResponse()
export class BotReportsController {
  constructor(
    @Inject(BOT_REPORTS_READER) private readonly reports: BotReportsReader,
  ) {}

  @Get('reports/sales')
  sales(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.getSalesSummary(dateRange(from, to));
  }

  @Get('reports/customers')
  customers(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.getCustomerSummary(dateRange(from, to));
  }

  @Get('inventory/low-stock')
  lowStock(@Query('threshold') rawThreshold = '3') {
    const threshold = Number(rawThreshold);

    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 10000) {
      throw new BadRequestException(
        'threshold must be an integer between 0 and 10000.',
      );
    }

    return this.reports.getLowStock({ threshold });
  }

  /**
   * سفارش پیدا‌نشده خطا نیست: پاسخ ۲۰۰ با `notFound: true` برمی‌گردد تا
   * ربات پیام «پیدا نشد» نشان دهد، نه خطای عمومی اتصال.
   */
  @Get('orders/:orderNumber')
  async order(@Param('orderNumber') orderNumber: string) {
    if (!/^[\p{L}\p{N}-]{2,64}$/u.test(orderNumber)) {
      throw new BadRequestException('Invalid order number.');
    }

    const order = await this.reports.getOrder(orderNumber);

    if (!order) {
      return { orderNumber, notFound: true };
    }

    return order;
  }
}
