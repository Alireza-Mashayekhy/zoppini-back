import { BadRequestException } from '@nestjs/common';

import {
  BlogBlockItem,
  BlogBlockSettings,
  BlogBlockType,
  BlogMediaType,
  BlogSliderColorOption,
  BlogSliderProduct,
} from '../entities/blog-block.entity';

/** سقف‌های امنیتی برای جلوگیری از payloadهای عجیب */
export const BLOCK_LIMITS = {
  maxBlocks: 50,
  maxContentLength: 500000,
  maxItemsPerBlock: 50,
  maxTitleLength: 150,
  maxQuestionLength: 500,
  maxAnswerLength: 5000,
  maxCaptionLength: 300,
  maxAltLength: 300,
  maxBadgeLength: 40,
  maxUrlLength: 1000,
  maxLinkLabelLength: 80,
} as const;

const DEFAULT_BLOCK_TITLES: Record<BlogBlockType, string | undefined> = {
  [BlogBlockType.Content]: undefined,
  [BlogBlockType.Faq]: 'سوالات متداول',
  [BlogBlockType.Slider]: 'محصولات مرتبط',
  [BlogBlockType.Media]: undefined,
  [BlogBlockType.Toc]: 'فهرست مطالب',
};

export interface BlockItemInput {
  html?: string;
  question?: string;
  answer?: string;
  mediaType?: BlogMediaType;
  url?: string;
  poster?: string;
  alt?: string;
  productId?: number;
  colorId?: number;
  badge?: string;
  caption?: string;
  linkUrl?: string;
  linkLabel?: string;
}

export interface BlockInput {
  type: BlogBlockType;
  title?: string;
  settings?: BlogBlockSettings;
  items?: BlockItemInput[];
}

export interface NormalizedBlock {
  type: BlogBlockType;
  order: number;
  title: string | null;
  settings: BlogBlockSettings | null;
  items: BlogBlockItem[];
}

/** رشته‌ی تمیزشده یا undefined (رشته‌ی خالی حذف می‌شود) */
function cleanString(
  value: unknown,
  maxLength: number,
  label: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'string') {
    throw new BadRequestException(`${label} باید متن باشد`);
  }

  const trimmed = value.trim();

  if (!trimmed) return undefined;

  if (trimmed.length > maxLength) {
    throw new BadRequestException(
      `${label} نمی‌تواند بیشتر از ${maxLength} کاراکتر باشد`,
    );
  }

  return trimmed;
}

/**
 * آدرس مدیا یا فقط نام فایل نسبی داخل uploads است (`images/xxx.webp`)
 * یا یک URL کامل http(s). هر چیز دیگری (مثل javascript:) رد می‌شود.
 */
export function isSafeMediaReference(value: string): boolean {
  if (!value || value.length > BLOCK_LIMITS.maxUrlLength) return false;

  if (/^https?:\/\/\S+$/i.test(value)) return true;

  if (value.startsWith('/')) return false;

  if (value.includes('..')) return false;

  return /^[a-zA-Z0-9._\-/]+$/.test(value);
}

/** لینک‌های مجاز: http(s) یا مسیر داخلی سایت */
function isSafeLink(value: string): boolean {
  if (!value || value.length > BLOCK_LIMITS.maxUrlLength) return false;

  if (/^https?:\/\/\S+$/i.test(value)) return true;

  if (/^\/[^\s]*$/.test(value)) return true;

  return /^mailto:[^\s]+$/i.test(value) || /^tel:[^\s]+$/i.test(value);
}

function validProductId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new BadRequestException('شناسه محصول نامعتبر است');
  }

  return parsed;
}

function normalizeItem(
  type: BlogBlockType,
  item: BlockItemInput,
): BlogBlockItem | null {
  if (type === BlogBlockType.Content) {
    const html = cleanString(
      item.html,
      BLOCK_LIMITS.maxContentLength,
      'متن بخش',
    );

    return html ? { html } : null;
  }

  if (type === BlogBlockType.Faq) {
    const question = cleanString(
      item.question,
      BLOCK_LIMITS.maxQuestionLength,
      'متن سوال',
    );
    const answer = cleanString(
      item.answer,
      BLOCK_LIMITS.maxAnswerLength,
      'متن پاسخ',
    );

    // آیتم کاملاً خالی (ادمین روی «افزودن» زده و چیزی ننوشته) حذف می‌شود
    if (!question && !answer) return null;

    if (!question || !answer) {
      throw new BadRequestException('سوال و پاسخ هر آیتم سوالات متداول الزامی است');
    }

    return { question, answer };
  }

  if (type === BlogBlockType.Media) {
    const url = cleanString(item.url, BLOCK_LIMITS.maxUrlLength, 'آدرس فایل');
    const poster = cleanString(
      item.poster,
      BLOCK_LIMITS.maxUrlLength,
      'آدرس پوستر',
    );
    const alt = cleanString(item.alt, BLOCK_LIMITS.maxAltLength, 'متن جایگزین');
    const caption = cleanString(
      item.caption,
      BLOCK_LIMITS.maxCaptionLength,
      'توضیح فایل',
    );
    const linkUrl = cleanString(
      item.linkUrl,
      BLOCK_LIMITS.maxUrlLength,
      'لینک',
    );

    if (!url && !poster && !caption) return null;

    const mediaType: BlogMediaType = item.mediaType === 'video' ? 'video' : 'image';

    if (!url) {
      throw new BadRequestException('برای هر آیتم مدیا باید فایل آپلود شود');
    }

    if (!isSafeMediaReference(url)) {
      throw new BadRequestException('آدرس فایل مدیا نامعتبر است');
    }

    if (poster && !isSafeMediaReference(poster)) {
      throw new BadRequestException('آدرس پوستر ویدیو نامعتبر است');
    }

    if (linkUrl && !isSafeLink(linkUrl)) {
      throw new BadRequestException('لینک آیتم مدیا نامعتبر است');
    }

    return {
      mediaType,
      url,
      ...(poster ? { poster } : {}),
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(linkUrl ? { linkUrl } : {}),
    };
  }

  if (type === BlogBlockType.Slider) {
    const productId = validProductId(item.productId);
    const colorId = validProductId(item.colorId);
    const badge = cleanString(item.badge, BLOCK_LIMITS.maxBadgeLength, 'برچسب');
    const title = cleanString(
      item.caption,
      BLOCK_LIMITS.maxCaptionLength,
      'عنوان نمایشی',
    );

    // آیتم بدون محصول چیزی برای نمایش ندارد (ادمین هنوز محصول انتخاب نکرده)
    if (!productId) return null;

    return {
      productId,
      ...(colorId ? { colorId } : {}),
      ...(badge ? { badge } : {}),
      ...(title ? { caption: title } : {}),
    };
  }

  // content و toc آیتم ندارند
  return null;
}

function normalizeSettings(
  type: BlogBlockType,
  settings: BlogBlockSettings | undefined,
): BlogBlockSettings | null {
  if (!settings) return null;

  // تنها تنظیم فعلی: پخش خودکار اسلایدر محصولات
  if (type === BlogBlockType.Slider) {
    return typeof settings.autoplay === 'boolean'
      ? { autoplay: settings.autoplay }
      : null;
  }

  return null;
}

/**
 * اعتبارسنجی و نرمال‌سازی ترتیب بلوک‌های مقاله.
 *
 * ترتیب آرایه‌ی ورودی همان ترتیب نمایش است (خروجی درگ‌دراپ پنل ادمین).
 */
export function normalizeBlocksPayload(blocks: BlockInput[]): NormalizedBlock[] {
  if (!Array.isArray(blocks)) {
    throw new BadRequestException('ساختار بخش‌های مقاله نامعتبر است');
  }

  if (blocks.length > BLOCK_LIMITS.maxBlocks) {
    throw new BadRequestException(
      `تعداد بخش‌های مقاله نمی‌تواند بیشتر از ${BLOCK_LIMITS.maxBlocks} باشد`,
    );
  }

  const normalized: NormalizedBlock[] = [];
  let hasContent = false;

  for (const block of blocks) {
    const type = block?.type;

    if (!type || !Object.values(BlogBlockType).includes(type)) {
      throw new BadRequestException('نوع بخش مقاله نامعتبر است');
    }

    if (type === BlogBlockType.Content) hasContent = true;

    const title =
      cleanString(block.title, BLOCK_LIMITS.maxTitleLength, 'عنوان بخش') ??
      DEFAULT_BLOCK_TITLES[type] ??
      null;

    const rawItems = Array.isArray(block.items) ? block.items : [];

    if (rawItems.length > BLOCK_LIMITS.maxItemsPerBlock) {
      throw new BadRequestException(
        `هر بخش حداکثر می‌تواند ${BLOCK_LIMITS.maxItemsPerBlock} آیتم داشته باشد`,
      );
    }

    const items = rawItems
      .map(item => normalizeItem(type, item ?? {}))
      .filter((item): item is BlogBlockItem => item !== null);

    normalized.push({
      type,
      order: normalized.length,
      title,
      settings: normalizeSettings(type, block.settings),
      items,
    });
  }

  // اگر بخش متن اصلی ارسال نشده باشد، به ابتدای مقاله اضافه می‌شود
  // (سازگار با مقالات قدیمی که بلوکی ندارند)
  if (!hasContent) {
    normalized.unshift({
      type: BlogBlockType.Content,
      order: 0,
      title: null,
      settings: null,
      items: [],
    });

    normalized.forEach((block, index) => {
      block.order = index;
    });
  }

  return normalized;
}

interface ProductVariantLike {
  price: number | string;
  stock?: number | null;
  colorId?: number | null;
  color?: { id: number; name: string; hexCode: string } | null;
}

interface ProductColorImageLike {
  url: string;
  color?: { id: number; name: string; hexCode: string } | null;
}

export interface ProductLike {
  id: number;
  title: string;
  slug: string;
  image?: string | null;
  variants?: ProductVariantLike[] | null;
  colorImages?: ProductColorImageLike[] | null;
}

function minPrice(variants: ProductVariantLike[]): number {
  const prices = variants
    .map(variant => Number(variant.price))
    .filter(price => Number.isFinite(price) && price > 0);

  return prices.length > 0 ? Math.min(...prices) : 0;
}

function anyInStock(variants: ProductVariantLike[]): boolean {
  return variants.some(variant => (variant.stock ?? 0) > 0);
}

/**
 * ساخت گزینه‌های رنگ محصول (اتحاد رنگ‌های واریانت‌ها و تصاویر رنگ).
 *
 * هر گزینه تصویر و کمترین قیمت همان رنگ را دارد تا هم اسلایدر عمومی و
 * هم پیش‌نمایش پنل ادمین بدون درخواست اضافه کار کنند.
 */
export function buildColorOptions(
  product: ProductLike,
): BlogSliderColorOption[] {
  const variants = product.variants ?? [];
  const colorImages = product.colorImages ?? [];

  const options = new Map<number, BlogSliderColorOption>();

  const ensureOption = (
    colorId: number,
    color?: { id: number; name: string; hexCode: string } | null,
  ): BlogSliderColorOption => {
    const existing = options.get(colorId);
    if (existing) return existing;

    const created: BlogSliderColorOption = {
      colorId,
      name: color?.name ?? '',
      hexCode: color?.hexCode ?? '',
      image: null,
      price: 0,
      inStock: false,
    };

    options.set(colorId, created);

    return created;
  };

  for (const variant of variants) {
    const colorId = variant.colorId ?? variant.color?.id;
    if (!colorId) continue;

    ensureOption(colorId, variant.color);
  }

  for (const image of colorImages) {
    const colorId = image.color?.id;
    if (!colorId) continue;

    const option = ensureOption(colorId, image.color);
    if (!option.image) option.image = image.url;
  }

  for (const option of options.values()) {
    const colorVariants = variants.filter(
      variant => variant.colorId === option.colorId,
    );

    option.price = minPrice(colorVariants);
    option.inStock = anyInStock(colorVariants);
    option.image = option.image ?? product.image ?? null;
  }

  return [...options.values()];
}

/**
 * تبدیل محصول به شکل سبکی که اسلایدر مقاله لازم دارد.
 *
 * اگر رنگ مشخصی انتخاب شده باشد، تصویر/قیمت/موجودی همان رنگ در بالای
 * آبجکت قرار می‌گیرد و رنگ‌های دیگر در colorOptions باقی می‌مانند.
 */
export function buildSliderProduct(
  product: ProductLike,
  colorId?: number,
): BlogSliderProduct {
  const variants = product.variants ?? [];
  const colorOptions = buildColorOptions(product);

  const selected = colorId
    ? colorOptions.find(option => option.colorId === colorId)
    : undefined;

  if (selected) {
    return {
      id: product.id,
      title: product.title,
      slug: product.slug,
      image: selected.image ?? product.image ?? null,
      price: selected.price,
      inStock: selected.inStock,
      colorOptions,
    };
  }

  return {
    id: product.id,
    title: product.title,
    slug: product.slug,
    image: product.colorImages?.[0]?.url ?? product.image ?? null,
    price: minPrice(variants),
    inStock: anyInStock(variants),
    colorOptions,
  };
}

export interface HydratableBlock {
  id: number;
  type: BlogBlockType;
  order: number;
  title: string | null;
  settings: BlogBlockSettings | null;
  items: BlogBlockItem[] | null;
}

/**
 * پر کردن اطلاعات محصول در آیتم‌های اسلایدر.
 *
 * محصول‌هایی که حذف شده‌اند با product: null برمی‌گردند تا ادمین متوجه شود؛
 * در نمایش عمومی از آن‌ها صرف‌نظر می‌شود.
 */
export function hydrateBlocksWithProducts<T extends HydratableBlock>(
  blocks: T[],
  products: Map<number, ProductLike>,
): T[] {
  return blocks.map(block => {
    if (block.type !== BlogBlockType.Slider) return block;

    const items = (block.items ?? [])
      .filter(item => typeof item.productId === 'number')
      .map(item => {
        const product = products.get(item.productId as number);

        return {
          ...item,
          product: product
            ? buildSliderProduct(product, item.colorId)
            : (null as BlogSliderProduct | null),
        };
      });

    return { ...block, items };
  });
}
