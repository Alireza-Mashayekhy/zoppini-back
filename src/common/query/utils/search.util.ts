import { Brackets, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/**
 * کاراکترهایی که در جست‌وجو نادیده گرفته می‌شوند.
 *
 * این‌ها هم از عبارت جست‌وجوی کاربر حذف می‌شوند و هم از مقدار ستون‌ها،
 * تا مثلاً «کت تک» و «کت‌تک» (با نیم‌فاصله) یک نتیجه بدهند.
 */
const IGNORED_CHARS = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\u00a0', // نیم‌فاصله لاتین (NBSP)
  '\u200c', // نیم‌فاصله فارسی (ZWNJ)
  '\u200d', // ZWJ
  '\u200e', // LRM
  '\u200f', // RLM
  '\u0640', // کشیده (ـ)
];

/**
 * معادل‌سازی حروف عربی/فارسی؛ چون بسته به کیبورد کاربر،
 * ممکن است «ي/ك» عربی تایپ شود در حالی که در دیتابیس «ی/ک» فارسی است.
 */
const EQUIVALENT_CHARS: [from: string, to: string][] = [
  ['\u0643', 'ک'], // ك عربی
  ['\u064a', 'ی'], // ي عربی
  ['\u0649', 'ی'], // ى (الف مقصوره)
  ['\u0623', 'ا'], // أ
  ['\u0625', 'ا'], // إ
  ['\u0629', 'ه'], // ة (تاء مربوطه)
];

/**
 * یکسان‌سازی متن (حذف فاصله‌ها/کاراکترهای نامرئی + معادل‌سازی حروف).
 */
function normalizeText(value: string): string {
  let term = value;

  for (const char of IGNORED_CHARS) {
    term = term.split(char).join('');
  }

  for (const [from, to] of EQUIVALENT_CHARS) {
    term = term.split(from).join(to);
  }

  return term.trim();
}

/**
 * یکسان‌سازی عبارت جست‌وجوی کاربر (trim + حذف فاصله‌ها + معادل‌سازی حروف).
 */
export function normalizeSearchTerm(search: unknown): string {
  if (typeof search === 'string') {
    return normalizeText(search);
  }

  if (typeof search === 'number') {
    return normalizeText(search.toString());
  }

  return '';
}

/**
 * همان یکسان‌سازی بالا، ولی به شکل عبارت SQL تا سمت دیتابیس هم
 * با همان قاعده مقایسه شود (وگرنه جست‌وجوی «کت تک» به «کت‌تک» نمی‌خورد).
 */
export function buildNormalizedColumnExpression(field: string): string {
  let expression = field;

  for (const char of IGNORED_CHARS) {
    expression = `REPLACE(${expression}, '${char}', '')`;
  }

  for (const [from, to] of EQUIVALENT_CHARS) {
    expression = `REPLACE(${expression}, '${from}', '${to}')`;
  }

  return expression;
}

/**
 * افزودن شرط جست‌وجو به کوئری.
 *
 * نکته مهم: شرط‌ها داخل یک گروه (Brackets) و با AND به بقیه کوئری اضافه
 * می‌شوند؛ در غیر این صورت ORها فیلترهای قبلی (موجودی، دسته‌بندی،
 * منتشرشده بودن و ...) را بی‌اثر می‌کنند.
 */
export function applySearch<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  search: unknown,
  fields: string[],
) {
  const term = normalizeSearchTerm(search);

  if (!term || !fields?.length) {
    return qb;
  }

  qb.andWhere(
    new Brackets(searchQb => {
      fields.forEach(field => {
        searchQb.orWhere(
          `${buildNormalizedColumnExpression(field)} LIKE :search`,
          {
            search: `%${term}%`,
          },
        );
      });
    }),
  );

  return qb;
}
