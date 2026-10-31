import { BadRequestException } from '@nestjs/common';

const DAY = 86400000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function localDay(ms: number): string {
  const parts = formatter.formatToParts(new Date(ms));
  const v = (name: string) => parts.find(part => part.type === name)?.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
}
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY)
    .toISOString()
    .slice(0, 10);
}
function valid(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const time = Date.parse(`${day}T00:00:00Z`);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day
  );
}
// Find the first UTC instant of a Tehran civil day, including historical DST
// days when local midnight did not exist, without relying on MySQL tz tables.
function startOfDay(day: string): number {
  const center = Date.parse(`${day}T00:00:00Z`);
  let lo = center - 2 * DAY,
    hi = center + 2 * DAY;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDay(mid) < day) lo = mid + 1;
    else hi = mid;
  }
  if (localDay(lo) !== day) throw new BadRequestException('روز نامعتبر');
  return lo;
}
const sqlDate = (ms: number) =>
  new Date(ms).toISOString().slice(0, 23).replace('T', ' ');
export function reportRange(start: string, end: string) {
  if (!valid(start) || !valid(end))
    throw new BadRequestException('تاریخ نامعتبر');
  const n =
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY +
    1;
  if (!Number.isInteger(n) || n < 1 || n > 366)
    throw new BadRequestException('بازه باید بین ۱ تا ۳۶۶ روز باشد');
  const days = Array.from({ length: n }, (_, i) => {
    const day = addDays(start, i);
    return {
      day,
      from: sqlDate(startOfDay(day)),
      to: sqlDate(startOfDay(addDays(day, 1))),
    };
  });
  return {
    start,
    end,
    from: days[0].from,
    to: days[days.length - 1].to,
    days,
    previousStart: addDays(start, -n),
    previousEnd: addDays(start, -1),
  };
}
