export const TEHRAN_TIMEZONE = 'Asia/Tehran' as const;
export const TEHRAN_OFFSET_SUFFIX = '+03:30';

export interface DateRangeBounds {
  start: string;
  endExclusive: string;
}

export function parseDateOnlyUtc(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);

  const isRealDate =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;

  return isRealDate ? time : null;
}

export function addDaysToDateString(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));

  return utc.toISOString().slice(0, 10);
}

export function toRangeBounds(range: {
  from: string;
  to: string;
}): DateRangeBounds {
  return {
    start: `${range.from} 00:00:00`,
    endExclusive: `${addDaysToDateString(range.to, 1)} 00:00:00`,
  };
}

export function currentDateInTehran(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TEHRAN_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function formatTehranDateTimeFa(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('fa-IR', {
    timeZone: TEHRAN_TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

/**
 * تبدیل تاریخ ذخیره‌شده در دیتابیس (ساعت دیواری تهران مطابق الگوی کل پروژه)
 * به رشتهٔ ISO با پسوند `+03:30`.
 */
export function toTehranWallClockIso(
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
      TEHRAN_OFFSET_SUFFIX
    );
  }

  const match = String(value)
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);

  if (!match) {
    return null;
  }

  return `${match[1]}T${match[2]}${TEHRAN_OFFSET_SUFFIX}`;
}
