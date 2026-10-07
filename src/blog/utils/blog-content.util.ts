import { BlogBlockType } from '../entities/blog-block.entity';
import {
  BLOCK_LIMITS,
  BlockInput,
  BlockItemInput,
  normalizeBlocksPayload,
  NormalizedBlock,
} from './blog-blocks.util';

/**
 * ترجمه‌ی HTML ادیتور یکپارچه به بخش‌های مقاله.
 *
 * قرارداد HTML (باید دقیقاً هم‌خوان با
 * `front/components/editor/lib/block-html.ts` باشد):
 *
 * ```html
 * <div class="zp-block" data-zp-block="slider" data-zp-config="{...}"></div>
 * ```
 *
 * هرچیزی که بیرون این div‌هاست، متن خود مقاله است و به بخش‌های content
 * تبدیل می‌شود. مقدار `data-zp-config` با entity escaping پروسی‌میرور
 * ذخیره شده (`"` → `&quot;`) پس پیش از JSON.parse باید برگردانده شود.
 *
 * نکته‌ی مهم: این ماژول برای مسیر «خواندن» مقاله است، پس هیچ داده‌ی
 * خرابی نباید باعث خطای ۵۰۰ یا از دست رفتن کل مقاله شود — بلوک نامعتبر
 * نادیده گرفته می‌شود و بقیه نمایش داده می‌شوند.
 */

/** یک div بلوک ویژه، همراه با متن قبل از آن */
const BLOCK_TAG_REGEX =
  /<div\b[^>]*data-zp-block\s*=\s*(["'])([^"']+)\1[^>]*>\s*<\/div>/gi;

const CONFIG_REGEX = /data-zp-config\s*=\s*"([^"]*)"/i;
const CONFIG_REGEX_SINGLE = /data-zp-config\s*=\s*'([^']*)'/i;

/** تگ‌هایی که حتی بدون متن، محتوای معنادار دارند (عکس، جدول، خط جداکننده) */
const NON_TEXT_TAG_REGEX =
  /<(img|video|audio|source|figure|table|iframe|hr|pre)\b/i;

const SUPPORTED_BLOCK_TYPES: BlogBlockType[] = [
  BlogBlockType.Slider,
  BlogBlockType.Media,
  BlogBlockType.Faq,
  BlogBlockType.Toc,
];

/** برگرداندن entity‌های HTML به کاراکتر واقعی (ترتیب: عددی، نام‌دار، amp آخر) */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number(decimal)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** آیا متن HTML هیچ بلوک ویژه‌ای (نشانه‌ی ادیتور جدید) دارد؟ */
export function hasEditorBlocks(html?: string | null): boolean {
  return !!html && /data-zp-block\s*=/.test(html);
}

/** خواندن و تجزیه‌ی تنظیمات یک بلوک؛ در صورت خرابی، آبجکت خالی */
export function decodeBlockConfig(openTag: string): Record<string, unknown> {
  const raw =
    CONFIG_REGEX.exec(openTag)?.[1] ?? CONFIG_REGEX_SINGLE.exec(openTag)?.[1];

  if (!raw) return {};

  try {
    const parsed = JSON.parse(decodeHtmlEntities(raw));

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** متن خالص یک تکه HTML (برای تشخیص اینکه آیا خالی است یا نه) */
function plainText(segment: string): string {
  return decodeHtmlEntities(segment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * آیا یک تکه از HTML ارزش نگه‌داشتن به‌عنوان بخش متن را دارد؟
 *
 * پاراگراف‌های خالی (`<p><br></p>`) دور ریخته می‌شوند تا فهرست بلوک‌ها
 * شلوغ نشود، ولی یک گالری یا جدول بدون متن معنادار است و می‌ماند.
 */
export function isMeaningfulSegment(segment: string): boolean {
  const trimmed = segment.trim();

  if (!trimmed) return false;

  return !!plainText(trimmed) || NON_TEXT_TAG_REGEX.test(trimmed);
}

/** آیتم‌های یک بلوک، از آرایه‌ی داخل تنظیمات */
function readItems(config: Record<string, unknown>): Record<string, unknown>[] {
  const items = config.items;

  if (!Array.isArray(items)) return [];

  return items
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => item as Record<string, unknown>);
}

function readString(
  item: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = item[key];

  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(
  item: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = item[key];

  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

/**
 * تبدیل تنظیمات ذخیره‌شده در HTML به ورودی استاندارد بخش‌های مقاله.
 *
 * اعتبارسنجی‌های سخت‌گیرانه (آدرس امن، طول مجاز، سوال/پاسخ اجباری) بعداً
 * در `normalizeBlocksPayload` انجام می‌شود؛ اینجا فقط شکل داده درست می‌شود.
 */
export function toBlockInput(
  kind: string,
  config: Record<string, unknown>,
): BlockInput | null {
  const type = kind.trim().toLowerCase() as BlogBlockType;

  if (!SUPPORTED_BLOCK_TYPES.includes(type)) return null;

  const title = readString(config, 'title');

  if (type === BlogBlockType.Toc) {
    return { type, title };
  }

  if (type === BlogBlockType.Faq) {
    const items: BlockItemInput[] = readItems(config).map(item => ({
      question: readString(item, 'question'),
      answer: readString(item, 'answer'),
    }));

    return { type, title, items };
  }

  if (type === BlogBlockType.Slider) {
    const items: BlockItemInput[] = readItems(config).map(item => ({
      productId: readNumber(item, 'productId'),
      colorId: readNumber(item, 'colorId'),
      badge: readString(item, 'badge'),
      caption: readString(item, 'caption'),
    }));

    return {
      type,
      title,
      settings: { autoplay: config.autoplay !== false },
      items,
    };
  }

  // media
  const items: BlockItemInput[] = readItems(config).map(item => ({
    mediaType: readString(item, 'mediaType') === 'video' ? 'video' : 'image',
    url: readString(item, 'url'),
    poster: readString(item, 'poster'),
    alt: readString(item, 'alt'),
    caption: readString(item, 'caption'),
    linkUrl: readString(item, 'linkUrl'),
  }));

  return { type, title, items };
}

/**
 * شکستن HTML مقاله به بخش‌های مرتب.
 *
 * نتیجه‌ی خالی یعنی «این مقاله نشانه‌ی ادیتور جدید ندارد» و سرویس باید
 * از رکوردهای قدیمی جدول blog_blocks استفاده کند.
 */
export function parseBlocksFromContent(html?: string | null): BlockInput[] {
  if (!html || !hasEditorBlocks(html)) return [];

  const inputs: BlockInput[] = [];

  let cursor = 0;

  for (const match of html.matchAll(BLOCK_TAG_REGEX)) {
    const start = match.index ?? 0;
    const [, , kind] = match;

    const segment = html.slice(cursor, start);
    if (isMeaningfulSegment(segment)) {
      inputs.push({
        type: BlogBlockType.Content,
        items: [{ html: segment.trim() }],
      });
    }

    const block = toBlockInput(kind, decodeBlockConfig(match[0]));
    if (block) inputs.push(block);

    cursor = start + match[0].length;
  }

  const tail = html.slice(cursor);
  if (isMeaningfulSegment(tail)) {
    inputs.push({
      type: BlogBlockType.Content,
      items: [{ html: tail.trim() }],
    });
  }

  return inputs.slice(0, BLOCK_LIMITS.maxBlocks);
}

/**
 * نرمال‌سازی هر بخش به‌تنهایی.
 *
 * عمداً همه‌ی بخش‌ها یکجا به `normalizeBlocksPayload` داده نمی‌شوند: آن
 * تابع با اولین داده‌ی نامعتبر کل درخواست را رد می‌کند (مناسب ذخیره‌ی
 * ادمین، نامناسب نمایش سایت). اینجا بخش خراب حذف می‌شود و بقیه سالم
 * می‌مانند.
 */
export function normalizeContentBlocks(
  inputs: BlockInput[],
): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];

  for (const input of inputs) {
    try {
      const normalized = normalizeBlocksPayload([input]);
      const block = normalized[normalized.length - 1];

      if (!block) continue;

      /**
       * بخش بی‌آیتم چیزی برای نمایش ندارد: متن خالی، اسلایدر/گالری/FAQ که
       * همه‌ی آیتم‌هایش نامعتبر بوده. تنها استثنا «فهرست مطالب» است که
       * ذاتاً آیتم ندارد و از تیترهای مقاله ساخته می‌شود.
       */
      if (block.items.length === 0 && block.type !== BlogBlockType.Toc) {
        continue;
      }

      blocks.push(block);
    } catch {
      // بخش نامعتبر نادیده گرفته می‌شود تا کل مقاله از دست نرود
    }
  }

  blocks.forEach((block, index) => {
    block.order = index;
  });

  return blocks;
}

/** HTML مقاله → بخش‌های آماده‌ی نمایش (یک مرحله‌ای) */
export function resolveBlocksFromContent(
  html?: string | null,
): NormalizedBlock[] {
  return normalizeContentBlocks(parseBlocksFromContent(html));
}
