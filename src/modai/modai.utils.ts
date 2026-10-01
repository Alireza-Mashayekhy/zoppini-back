import { ResolvedProductGuides } from 'src/product-guides/guide-resolution';

import {
  ModaiSizeGuide,
  ModaiSizeGuideTable,
} from './interfaces/modai-api.interface';

/** timezone ایران: +03:30 (ساعت تابستانی از سال ۱۴۰۱ حذف شده است) */
export const TEHRAN_TIMEZONE_SUFFIX = '+03:30';

const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

/** لیبل ستون اول جدول سایز در قالب مدآی */
export const SIZE_TABLE_FIRST_HEADER = 'سایز';

/** برچسب ویژگی‌های تنوع در مدآی */
export const COLOR_ATTRIBUTE_TITLE = 'رنگ';
export const SIZE_ATTRIBUTE_TITLE = 'سایز';

export interface AbsoluteUrlOptions {
  /** ریشهٔ سایت — برای مسیرهای نسبی مثل `/uploads/abc.jpg` */
  siteUrl: string;

  /**
   * اگر تنظیم شود، فایل‌های بدون مسیر (مثل `abc.jpg`) با همین پیشوند ساخته
   * می‌شوند؛ مثلاً `https://cdn.example.com/uploads`.
   */
  imageBaseUrl?: string | null;

  /** پیشوند پیش‌فرض فایل‌های آپلودی (همان static assets بک‌اند) */
  uploadPath?: string;
}

/**
 * تبدیل مسیر ذخیره‌شده در دیتابیس به آدرس مطلق.
 *
 * در دیتابیس، تصاویر هم به شکل نام فایل (`abc.jpg`)، هم مسیر نسبی
 * (`/uploads/abc.jpg`) و هم آدرس کامل ذخیره می‌شوند؛ هر سه حالت پشتیبانی می‌شود
 * چون مدآی فقط آدرس مطلق را قبول می‌کند.
 */
export function toAbsoluteUrl(
  value: string | null | undefined,
  options: AbsoluteUrlOptions,
): string | null {
  const path = String(value ?? '').trim();

  if (!path) {
    return null;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  if (path.startsWith('/')) {
    return `${normalizeBaseUrl(options.siteUrl)}${path}`;
  }

  const uploadPath = normalizeBaseUrl(options.uploadPath ?? '/uploads');

  if (options.imageBaseUrl) {
    return `${normalizeBaseUrl(options.imageBaseUrl)}/${path}`;
  }

  return `${normalizeBaseUrl(options.siteUrl)}${uploadPath}/${path}`;
}

export function normalizeBaseUrl(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/\/+$/, '');
}

export function truncate(
  value: string | null | undefined,
  maxLength: number,
): string {
  const text = String(value ?? '');

  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * تبدیل تاریخ خوانده‌شده از دیتابیس به iso8601 همراه با timezone ایران.
 *
 * کوئری‌ها تاریخ را با `DATE_FORMAT` به شکل `YYYY-MM-DDTHH:mm:ss` (ساعت دیواری
 * تهران) برمی‌گردانند تا درگیری timezone سمت دیتابیس/سرور وارد نشود؛ اگر ورودی
 * شیء Date باشد، همان لحظه به وقت تهران تبدیل می‌شود.
 */
export function toTehranIso(value: string | Date | null | undefined): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return nowInTehranIso();
    }

    const shifted = new Date(value.getTime() + TEHRAN_OFFSET_MS);

    return `${shifted.toISOString().slice(0, 19)}${TEHRAN_TIMEZONE_SUFFIX}`;
  }

  const text = String(value ?? '').trim();

  const match = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);

  if (!match) {
    return nowInTehranIso();
  }

  return `${match[1]}T${match[2]}${TEHRAN_TIMEZONE_SUFFIX}`;
}

function nowInTehranIso(): string {
  const now = new Date(Date.now() + TEHRAN_OFFSET_MS);

  return `${now.toISOString().slice(0, 19)}${TEHRAN_TIMEZONE_SUFFIX}`;
}

/**
 * تبدیل توضیحات HTML ادیتور به متن ساده.
 *
 * مدآی فرمت توضیحات را مشخص نکرده است؛ متن ساده انتخاب شده تا در همهٔ
 * نمایش‌دهنده‌ها درست دیده شود. تگ‌های بلوکی به خط جدید تبدیل می‌شوند تا
 * پاراگراف‌بندی توضیحات حفظ شود.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  const raw = String(html ?? '').trim();

  if (!raw) {
    return '';
  }

  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6]|tr|table|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&zwnj;/gi, '\u200c')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      safeFromCharCode(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      safeFromCharCode(parseInt(code, 10)),
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeFromCharCode(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : '';
}

/**
 * تبدیل جدول سایزبندی زوپینی به قالب مدآی.
 *
 * در زوپینی «ستون‌ها» سایزها (S/M/L یا ۴۶/۴۸) و «ردیف‌ها» اندازه‌ها
 * (عرض سینه، قد آستین) هستند؛ ولی در قالب مدآی هر ردیفِ جدول یک سایز است و
 * ستون‌ها اندازه‌ها. پس جدول باید ترانهاده (transpose) شود.
 */
export function transposeSizeTable(
  columns: { id: number; label: string }[],
  rows: {
    id: number;
    label: string;
    values: { columnId: number; value: string | null }[];
  }[],
  firstHeader: string = SIZE_TABLE_FIRST_HEADER,
): ModaiSizeGuideTable {
  const headers = [firstHeader, ...rows.map(row => row.label)];

  const dataRows = columns.map(column => [
    column.label,
    ...rows.map(row => {
      const cell = row.values.find(value => value.columnId === column.id);

      return cell?.value ?? '';
    }),
  ]);

  return { headers, rows: dataRows };
}

/**
 * ساخت `size_guide` از راهنمای حل‌شدهٔ محصول.
 *
 * متن از راهنمای اندازه‌گیری (و در نبود آن از توضیحات جدول سایز) و تصویر از
 * اولین تصویر راهنمای اندازه‌گیری برداشته می‌شود. اگر محصول هیچ راهنمایی
 * نداشته باشد `null` برگردانده می‌شود (فیلد اختیاری است).
 */
export function buildSizeGuide(
  resolved: ResolvedProductGuides | null | undefined,
  resolveImageUrl: (file: string) => string | null,
): ModaiSizeGuide | null {
  if (!resolved) {
    return null;
  }

  const sizeTable = resolved.sizeTable;
  const measurementGuide = resolved.measurementGuide;

  const text =
    String(measurementGuide?.notes ?? '').trim() ||
    String(sizeTable?.notes ?? '').trim();

  const firstImage = measurementGuide?.images?.[0]?.file;

  const imageLink = firstImage ? (resolveImageUrl(firstImage) ?? '') : '';

  const table =
    sizeTable && sizeTable.columns.length
      ? transposeSizeTable(sizeTable.columns, sizeTable.rows)
      : null;

  if (!table && !imageLink && !text) {
    return null;
  }

  return {
    text,
    image_link: imageLink,
    table,
  };
}
