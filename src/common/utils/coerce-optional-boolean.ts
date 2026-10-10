/**
 * تبدیل مقدار اختیاری فرم چندقسمتی به بولین برای اعتبارسنجی با
 * `@IsBoolean()`:
 *
 * - `'true'`/`true` → `true`
 * - `'false'`/`false` → `false`
 * - خالی/تعریف‌نشده → `undefined` (فیلد اختیاری است؛ پیش‌فرض ستون دیتابیس
 *   اعمال می‌شود)
 * - هر مقدار دیگری دست‌نخورده برمی‌گردد تا `@IsBoolean()` آن را رد کند؛
 *   این‌طوری مقدار نامعتبر، بی‌صدا به `false` تبدیل نمی‌شود.
 */
export function coerceOptionalBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  if (value === undefined || value === null || value === '') return undefined;
  return value as boolean;
}
