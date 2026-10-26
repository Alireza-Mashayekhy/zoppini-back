export const UTF8_BOM = '\uFEFF';

/**
 * ایمن‌سازی سلول CSV برای نرم‌افزارهای صفحه‌گسترده (Excel / Google Sheets):
 *   - جلوگیری از CSV Formula Injection در رشته‌هایی که با `=`, `+`, `-`, `@` شروع می‌شوند
 *   - رعایت استاندارد RFC 4180 برای کاما، خط جدید و گیومهٔ دوتایی
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  if (typeof value === 'boolean') {
    return value ? 'بله' : 'خیر';
  }

  const rawText =
    typeof value === 'string'
      ? value
      : value instanceof Date
        ? value.toISOString()
        : JSON.stringify(value);

  let text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (/^[=+\-@\t]/.test(text) && !/^-\d+(\.\d+)?$/.test(text)) {
    text = `'${text}`;
  }

  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function buildUtf8Csv(options: {
  metadataCells?: string[];
  headers: string[];
  rows: Array<Array<unknown>>;
}): string {
  const lines: string[] = [];

  if (options.metadataCells && options.metadataCells.length > 0) {
    lines.push(options.metadataCells.map(escapeCsvCell).join(','));
  }

  lines.push(options.headers.map(escapeCsvCell).join(','));

  for (const row of options.rows) {
    lines.push(row.map(escapeCsvCell).join(','));
  }

  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}
