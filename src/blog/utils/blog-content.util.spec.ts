import { BlogBlockType } from '../entities/blog-block.entity';
import {
  decodeBlockConfig,
  decodeHtmlEntities,
  hasEditorBlocks,
  isMeaningfulSegment,
  parseBlocksFromContent,
  resolveBlocksFromContent,
} from './blog-content.util';

/**
 * تست ترجمه‌ی HTML ادیتور یکپارچه به بخش‌های مقاله.
 *
 * نمونه‌های HTML دقیقاً به همان شکلی نوشته شده‌اند که
 * `front/components/editor/lib/block-html.ts` تولید می‌کند (JSON فرار‌شده
 * داخل صفت data-zp-config). هر تغییر در آن قرارداد باید اینجا هم دیده شود.
 */

/** ساخت HTML یک بلوک، هم‌شکل با فرانت (فرار کردن " ' & < >) */
function blockHtml(kind: string, config: Record<string, unknown>): string {
  const encoded = JSON.stringify(config).replace(
    /[&<>"']/g,
    character =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] as string,
  );

  return `<div class="zp-block" data-zp-block="${kind}" data-zp-config="${encoded}"></div>`;
}

describe('blog content → blocks', () => {
  it('متن، اسلایدر، متن و FAQ را به همان ترتیب مقاله برمی‌گرداند', () => {
    const html = [
      '<h2>مقدمه</h2><p>یک پاراگراف فارسی.</p>',
      blockHtml('slider', {
        title: 'محصولات این مطلب',
        autoplay: false,
        items: [{ productId: 12, colorId: 3, badge: 'جدید' }],
      }),
      '<p>بعد از اسلایدر هم متن داریم.</p>',
      blockHtml('faq', {
        title: 'سوالات متداول',
        items: [{ question: 'سایز چطور است؟', answer: 'استاندارد' }],
      }),
    ].join('');

    const blocks = resolveBlocksFromContent(html);

    expect(blocks.map(block => block.type)).toEqual([
      BlogBlockType.Content,
      BlogBlockType.Slider,
      BlogBlockType.Content,
      BlogBlockType.Faq,
    ]);

    expect(blocks.map(block => block.order)).toEqual([0, 1, 2, 3]);

    expect(blocks[0].items[0]?.html).toBe(
      '<h2>مقدمه</h2><p>یک پاراگراف فارسی.</p>',
    );

    expect(blocks[1].title).toBe('محصولات این مطلب');
    expect(blocks[1].settings).toEqual({ autoplay: false });
    expect(blocks[1].items[0]).toMatchObject({
      productId: 12,
      colorId: 3,
      badge: 'جدید',
    });

    expect(blocks[3].items[0]).toMatchObject({
      question: 'سایز چطور است؟',
      answer: 'استاندارد',
    });
  });

  it('مدیا و گالری را با نوع فایل، پوستر، کپشن و لینک می‌سازد', () => {
    const html = blockHtml('media', {
      title: 'گالری',
      items: [
        {
          mediaType: 'image',
          url: 'images/look-1.webp',
          alt: 'نمای اول',
          caption: 'کت تک',
        },
        {
          mediaType: 'video',
          url: 'videos/show.mp4',
          poster: 'videos/show.webp',
          linkUrl: 'https://example.com/look',
        },
      ],
    });

    const blocks = resolveBlocksFromContent(html);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe(BlogBlockType.Media);
    expect(blocks[0].items).toEqual([
      {
        mediaType: 'image',
        url: 'images/look-1.webp',
        alt: 'نمای اول',
        caption: 'کت تک',
      },
      {
        mediaType: 'video',
        url: 'videos/show.mp4',
        poster: 'videos/show.webp',
        linkUrl: 'https://example.com/look',
      },
    ]);
  });

  it('فهرست مطالب بدون آیتم و با عنوان پیش‌فرض ساخته می‌شود', () => {
    const blocks = resolveBlocksFromContent(
      '<p>متن</p>' + blockHtml('toc', {}),
    );

    expect(blocks[1]).toMatchObject({
      type: BlogBlockType.Toc,
      title: 'فهرست مطالب',
      items: [],
    });
  });

  it('کاراکترهای نقل‌قول و امپرسند داخل متن آیتم‌ها سالم می‌مانند', () => {
    const html = blockHtml('faq', {
      items: [
        {
          question: 'آیا "کد تخفیف" دارید؟',
          answer: "بله؛ با 'ZOPPINI' و علامت & استفاده کنید.",
        },
      ],
    });

    // صفت ذخیره‌شده باید فرار‌شده باشد، وگرنه HTML مقاله خراب می‌شود
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
    expect(html).toContain('&amp;');

    const blocks = resolveBlocksFromContent(html);

    expect(blocks[0].items[0]).toEqual({
      question: 'آیا "کد تخفیف" دارید؟',
      answer: "بله؛ با 'ZOPPINI' و علامت & استفاده کنید.",
    });
  });

  it('entityهای HTML را درست برمی‌گرداند (ampersand دوباره فرار‌شده خراب نمی‌شود)', () => {
    expect(decodeHtmlEntities('A &amp;amp; B')).toBe('A &amp; B');
    expect(decodeHtmlEntities('&quot;x&quot; &#39;y&#39;')).toBe(`"x" 'y'`);
    expect(decodeHtmlEntities('&#x2713;')).toBe('✓');
  });

  it('پاراگراف‌های خالی را دور می‌ریزد ولی عکس و جدول بدون متن را نگه می‌دارد', () => {
    expect(isMeaningfulSegment('<p><br></p>')).toBe(false);
    expect(isMeaningfulSegment('<p></p><p> </p>')).toBe(false);
    expect(isMeaningfulSegment('<p>سلام</p>')).toBe(true);
    expect(
      isMeaningfulSegment(
        '<figure class="zp-figure"><img src="a.webp"></figure>',
      ),
    ).toBe(true);
    expect(isMeaningfulSegment('<table><tr><td></td></tr></table>')).toBe(true);
    expect(isMeaningfulSegment('<hr>')).toBe(true);

    const html = '<p><br></p>' + blockHtml('toc', {}) + '<p></p>';

    expect(resolveBlocksFromContent(html)).toHaveLength(1);
  });

  it('تکه‌ی HTML بین دو بلوک، جدا از متن قبل و بعد نگه داشته می‌شود', () => {
    const html = [
      '<p>اول</p>',
      blockHtml('toc', {}),
      '<h3>تیتر</h3><p>وسط</p>',
      blockHtml('toc', {}),
      '<p>آخر</p>',
    ].join('');

    const blocks = parseBlocksFromContent(html);

    expect(blocks.map(block => block.type)).toEqual([
      BlogBlockType.Content,
      BlogBlockType.Toc,
      BlogBlockType.Content,
      BlogBlockType.Toc,
      BlogBlockType.Content,
    ]);

    expect(
      blocks
        .filter(block => block.type === BlogBlockType.Content)
        .map(block => block.items?.[0]?.html),
    ).toEqual(['<p>اول</p>', '<h3>تیتر</h3><p>وسط</p>', '<p>آخر</p>']);
  });

  it('بلوک خراب را نادیده می‌گیرد و بقیه‌ی مقاله را نشان می‌دهد', () => {
    const html = [
      '<p>متن سالم</p>',
      '<div class="zp-block" data-zp-block="gallery" data-zp-config="{}"></div>', // نوع ناشناخته
      '<div class="zp-block" data-zp-block="faq" data-zp-config="{خراب"></div>', // JSON نامعتبر
      blockHtml('faq', { items: [{ question: 'بی‌پاسخ' }] }), // پاسخ اجباری
      blockHtml('media', {
        items: [{ mediaType: 'image', url: 'javascript:bad()' }],
      }),
      blockHtml('faq', {
        items: [{ question: 'سوال خوب؟', answer: 'پاسخ خوب' }],
      }),
      '<p>متن پایانی</p>',
    ].join('');

    const blocks = resolveBlocksFromContent(html);

    expect(blocks.map(block => block.type)).toEqual([
      BlogBlockType.Content,
      BlogBlockType.Faq,
      BlogBlockType.Content,
    ]);
    expect(blocks.map(block => block.order)).toEqual([0, 1, 2]);
    expect(blocks[1].items[0]).toMatchObject({ question: 'سوال خوب؟' });
  });

  it('آیتم‌های نیمه‌کاره (ادمین هنوز محصول انتخاب نکرده) ذخیره نمی‌شوند', () => {
    const html = blockHtml('slider', {
      items: [{ badge: 'بدون محصول' }, { productId: 7 }],
    });

    expect(resolveBlocksFromContent(html)[0].items).toEqual([{ productId: 7 }]);
  });

  it('مقاله‌ی بدون نشانه‌ی ادیتور جدید، هیچ بخشی نمی‌سازد', () => {
    expect(hasEditorBlocks('<p>فقط متن</p>')).toBe(false);
    expect(parseBlocksFromContent('<p>فقط متن</p>')).toEqual([]);
    expect(parseBlocksFromContent(null)).toEqual([]);
    expect(parseBlocksFromContent('')).toEqual([]);

    const withBlock = blockHtml('toc', {});
    expect(hasEditorBlocks(withBlock)).toBe(true);
    expect(parseBlocksFromContent(withBlock)).toHaveLength(1);
  });

  it('تنظیمات بلوک را از تگ باز می‌خواند (با کوتیشن تک و دو)', () => {
    expect(
      decodeBlockConfig(
        '<div data-zp-block="faq" data-zp-config="{&quot;a&quot;:1}">',
      ),
    ).toEqual({ a: 1 });

    expect(
      decodeBlockConfig("<div data-zp-block='faq' data-zp-config='{\"a\":2}'>"),
    ).toEqual({ a: 2 });

    expect(decodeBlockConfig('<div data-zp-block="faq">')).toEqual({});
    expect(decodeBlockConfig('<div data-zp-config="[1,2]">')).toEqual({});
    expect(decodeBlockConfig('<div data-zp-config="null">')).toEqual({});
  });

  it('مقادیر رشته‌ای در تنظیمات (مثل productId) به عدد تبدیل می‌شوند', () => {
    const blocks = resolveBlocksFromContent(
      blockHtml('slider', { items: [{ productId: '31', colorId: '4' }] }),
    );

    expect(blocks[0].items[0]).toMatchObject({ productId: 31, colorId: 4 });
  });

  it('مقاله‌ی پر‌بلوک از سقف تعداد بخش‌ها بیشتر نمی‌شود', () => {
    const many = Array.from({ length: 80 }, (_value, index) =>
      blockHtml('toc', { title: `فهرست ${index}` }),
    ).join('<p>متن</p>');

    const blocks = resolveBlocksFromContent(many);

    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.every(block => typeof block.order === 'number')).toBe(true);
  });
});
