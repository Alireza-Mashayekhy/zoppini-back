const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** تبدیل ارقام فارسی و عربی به لاتین */
export function toLatinDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, digit => String(PERSIAN_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String(ARABIC_DIGITS.indexOf(digit)));
}

export function normalizeCellValue(value?: string | null): string | null {
  if (value === null || value === undefined) return null;

  const trimmed = toLatinDigits(String(value))
    .replace(/[٬،,]/g, '')
    .replace(/٫/g, '.')
    .trim();

  if (!trimmed) return null;

  /** اگر عدد بود، فرم نهایی را استاندارد می‌کنیم (۵۸٫۵ → 58.5) */
  const numeric = trimmed.replace(/\s+/g, '');

  if (/^-?\d+(\.\d+)?$/.test(numeric)) {
    const [integer, fraction] = numeric.split('.');

    const normalizedInteger = String(Number(integer));

    return fraction === undefined
      ? normalizedInteger
      : `${normalizedInteger}.${fraction}`;
  }

  return trimmed;
}

/** آیا مقدار عددی معتبر است یا خالی */
export function isValidCellValue(value?: string | null): boolean {
  const normalized = normalizeCellValue(value);

  if (normalized === null) return true;

  return /^-?\d+(\.\d+)?$/.test(normalized);
}

export function normalizeText(value?: string | null): string | null {
  if (value === null || value === undefined) return null;

  const trimmed = String(value).trim();

  return trimmed.length ? trimmed : null;
}
