import { BadRequestException } from '@nestjs/common';

import { BOT_MAX_DATE_RANGE_DAYS, BOT_TIME_ZONE } from '../bot.constants';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TehranDateRange {
  /** تاریخ شروع به شکل YYYY-MM-DD (تقویم میلادی) */
  from: string;
  /** تاریخ پایان به شکل YYYY-MM-DD (شامل همین روز) */
  to: string;
  /** شروع روز `from` در Asia/Tehran به UTC */
  fromUtc: Date;
  /** شروع روز بعد از `to` در Asia/Tehran به UTC (بازه‌ی نیمه‌باز) */
  toExclusiveUtc: Date;
}

function badRequest(message: string): never {
  throw new BadRequestException({
    statusCode: 400,
    message,
    error: 'Bad Request',
    code: 'INVALID_DATE_RANGE',
  });
}

/**
 * اختلاف زمانی یک لحظه‌ی UTC با همان لحظه در منطقه‌ی زمانی مشخص را
 * بر حسب میلی‌ثانیه برمی‌گرداند. برای Asia/Tehran مثبت است (+03:30).
 *
 * از Intl استفاده می‌کنیم تا تغییرات تاریخی offset (قبل از حذف ساعت
 * تابستانی در ایران) هم درست محاسبه شوند.
 */
function timeZoneOffsetMs(instant: Date, timeZone = BOT_TIME_ZONE): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(instant);
  const values: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  let hour = Number(values.hour);
  // بعضی نسخه‌های ICU نیمه‌شب را 24 نشان می‌دهند.
  if (hour === 24) {
    hour = 0;
  }

  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    hour,
    Number(values.minute),
    Number(values.second),
  );

  return asUtc - instant.getTime();
}

export function parseTehranDate(
  value: string | undefined,
  field: string,
): string {
  const normalized = (value ?? '').trim();

  if (!normalized) {
    badRequest(`پارامتر ${field} الزامی است و باید به شکل YYYY-MM-DD باشد.`);
  }

  if (!DATE_PATTERN.test(normalized)) {
    badRequest(`پارامتر ${field} باید به شکل YYYY-MM-DD باشد.`);
  }

  const [year, month, day] = normalized.split('-').map(Number);

  if (year < 1970 || year > 2100) {
    badRequest(`سال پارامتر ${field} معتبر نیست.`);
  }

  const probe = new Date(Date.UTC(year, month - 1, day));

  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    badRequest(`تاریخ پارامتر ${field} معتبر نیست.`);
  }

  return normalized;
}

/**
 * شروع یک تاریخ تقویمی در Asia/Tehran را به لحظه‌ی UTC تبدیل می‌کند.
 * دو مرحله محاسبه‌ی offset برای پوشش مرزهای تغییر ساعت انجام می‌شود.
 */
export function tehranStartOfDayUtc(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const naiveMidnightUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  let instant = naiveMidnightUtc - timeZoneOffsetMs(new Date(naiveMidnightUtc));
  instant = naiveMidnightUtc - timeZoneOffsetMs(new Date(instant));

  return new Date(instant);
}

export function addDaysToDateString(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function daysBetweenDateStrings(from: string, to: string): number {
  const fromParts = from.split('-').map(Number);
  const toParts = to.split('-').map(Number);
  const fromUtc = Date.UTC(fromParts[0], fromParts[1] - 1, fromParts[2]);
  const toUtc = Date.UTC(toParts[0], toParts[1] - 1, toParts[2]);
  return Math.round((toUtc - fromUtc) / MS_PER_DAY);
}

/**
 * بازه‌ی تاریخ ورودی API را اعتبارسنجی می‌کند و مرزهای UTC آن را
 * بر اساس منطقه‌ی زمانی Asia/Tehran می‌سازد. `to` شامل خود روز است.
 */
export function parseTehranDateRange(
  fromRaw: string | undefined,
  toRaw: string | undefined,
): TehranDateRange {
  const from = parseTehranDate(fromRaw, 'from');
  const to = parseTehranDate(toRaw, 'to');

  const span = daysBetweenDateStrings(from, to);

  if (span < 0) {
    badRequest('تاریخ شروع (from) نباید بعد از تاریخ پایان (to) باشد.');
  }

  if (span > BOT_MAX_DATE_RANGE_DAYS) {
    badRequest(
      `حداکثر بازه‌ی مجاز ${BOT_MAX_DATE_RANGE_DAYS} روز است. برای بازه‌های بزرگ‌تر از پنل مدیریت استفاده کنید.`,
    );
  }

  return {
    from,
    to,
    fromUtc: tehranStartOfDayUtc(from),
    // شروع روز بعد، تا خودِ روز `to` هم کامل شامل شود.
    toExclusiveUtc: tehranStartOfDayUtc(addDaysToDateString(to, 1)),
  };
}

export function todayInTehran(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BOT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const values: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}
