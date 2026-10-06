import { BadRequestException } from '@nestjs/common';

import { BlogBlockType } from '../entities/blog-block.entity';
import {
  buildSliderProduct,
  hydrateBlocksWithProducts,
  isSafeMediaReference,
  normalizeBlocksPayload,
} from './blog-blocks.util';

describe('normalizeBlocksPayload', () => {
  it('اگر بخش متن اصلی ارسال نشود، آن را به ابتدای مقاله اضافه می‌کند', () => {
    const blocks = normalizeBlocksPayload([
      { type: BlogBlockType.Faq, items: [{ question: 'سوال؟', answer: 'جواب' }] },
    ]);

    expect(blocks.map(block => block.type)).toEqual([
      BlogBlockType.Content,
      BlogBlockType.Faq,
    ]);
    expect(blocks.map(block => block.order)).toEqual([0, 1]);
  });

  it('ترتیب بخش‌ها را دقیقاً مطابق ترتیب آرایه ورودی نگه می‌دارد', () => {
    const blocks = normalizeBlocksPayload([
      { type: BlogBlockType.Toc },
      { type: BlogBlockType.Slider, items: [{ productId: 5 }] },
      { type: BlogBlockType.Content },
      { type: BlogBlockType.Faq, items: [{ question: '۰', answer: '۰' }] },
    ]);

    expect(blocks.map(block => block.type)).toEqual([
      BlogBlockType.Toc,
      BlogBlockType.Slider,
      BlogBlockType.Content,
      BlogBlockType.Faq,
    ]);
    expect(blocks.map(block => block.order)).toEqual([0, 1, 2, 3]);
  });

  it('عنوان پیش‌فرض بخش‌ها را می‌گذارد', () => {
    const titles = normalizeBlocksPayload([
      { type: BlogBlockType.Content },
      { type: BlogBlockType.Faq },
      { type: BlogBlockType.Slider },
      { type: BlogBlockType.Toc },
    ]).map(block => block.title);

    expect(titles).toEqual([
      null,
      'سوالات متداول',
      'محصولات مرتبط',
      'فهرست مطالب',
    ]);
  });

  it('عنوان دلخواه ادمین را جایگزین پیش‌فرض می‌کند', () => {
    const blocks = normalizeBlocksPayload([
      { type: BlogBlockType.Faq, title: 'پرسش‌های پرتکرار', items: [] },
    ]);

    expect(blocks[1].title).toBe('پرسش‌های پرتکرار');
  });

  it('آیتم‌های خالی سوالات متداول را حذف می‌کند', () => {
    const blocks = normalizeBlocksPayload([
      { type: BlogBlockType.Content },
      {
        type: BlogBlockType.Faq,
        items: [
          {},
          { question: '', answer: '   ' },
          { question: 'سوال واقعی', answer: 'پاسخ واقعی' },
        ],
      },
    ]);

    const faqBlock = blocks.find(block => block.type === BlogBlockType.Faq);

    expect(faqBlock?.items).toHaveLength(1);
    expect(faqBlock?.items[0]).toEqual({
      question: 'سوال واقعی',
      answer: 'پاسخ واقعی',
    });
  });

  it('سوال بدون پاسخ را رد می‌کند', () => {
    expect(() =>
      normalizeBlocksPayload([
        { type: BlogBlockType.Faq, items: [{ question: 'فقط سوال' }] },
      ]),
    ).toThrow(BadRequestException);
  });

  it('دو بخش متن اصلی را قبول نمی‌کند', () => {
    expect(() =>
      normalizeBlocksPayload([
        { type: BlogBlockType.Content },
        { type: BlogBlockType.Content },
      ]),
    ).toThrow(BadRequestException);
  });

  it('آیتم مدیا بدون فایل را رد و آدرس ناامن را مسدود می‌کند', () => {
    expect(() =>
      normalizeBlocksPayload([
        { type: BlogBlockType.Media, items: [{ caption: 'بدون فایل' }] },
      ]),
    ).toThrow(BadRequestException);

    expect(() =>
      normalizeBlocksPayload([
        {
          type: BlogBlockType.Media,
          items: [{ mediaType: 'image', url: 'javascript:alert(1)' }],
        },
      ]),
    ).toThrow(BadRequestException);
  });

  it('فایل آپلودشده و ویدیو با پوستر را نگه می‌دارد', () => {
    const blocks = normalizeBlocksPayload([
      { type: BlogBlockType.Content },
      {
        type: BlogBlockType.Media,
        items: [
          { mediaType: 'video', url: 'videos/a.mp4', poster: 'images/p.webp' },
          { mediaType: 'image', url: 'https://cdn.example.com/a.webp' },
        ],
      },
    ]);

    const media = blocks.find(block => block.type === BlogBlockType.Media);

    expect(media?.items).toEqual([
      {
        mediaType: 'video',
        url: 'videos/a.mp4',
        poster: 'images/p.webp',
      },
      { mediaType: 'image', url: 'https://cdn.example.com/a.webp' },
    ]);
  });

  it('آیتم اسلایدر بدون محصول را حذف می‌کند و رنگ را نگه می‌دارد', () => {
    const blocks = normalizeBlocksPayload([
      { type: BlogBlockType.Content },
      {
        type: BlogBlockType.Slider,
        items: [{ badge: 'جدید' }, { productId: 12, colorId: 3, badge: 'ویژه' }],
      },
    ]);

    const slider = blocks.find(block => block.type === BlogBlockType.Slider);

    expect(slider?.items).toEqual([
      { productId: 12, colorId: 3, badge: 'ویژه' },
    ]);
  });

  it('سقف تعداد آیتم‌ها را اعمال می‌کند', () => {
    const items = Array.from({ length: 51 }, (_, index) => ({
      question: `سوال ${index}`,
      answer: 'پاسخ',
    }));

    expect(() =>
      normalizeBlocksPayload([{ type: BlogBlockType.Faq, items }]),
    ).toThrow(BadRequestException);
  });

  it('نوع ناشناخته بخش را رد می‌کند', () => {
    expect(() =>
      normalizeBlocksPayload([{ type: 'video-gallery' as BlogBlockType }]),
    ).toThrow(BadRequestException);
  });
});

describe('isSafeMediaReference', () => {
  it.each([
    'images/abc.webp',
    'videos/abc.mp4',
    'https://cdn.example.com/a.mp4',
    'http://localhost:3000/uploads/images/a.webp',
  ])('آدرس مجاز %s', value => {
    expect(isSafeMediaReference(value)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    '../../etc/passwd',
    '/absolute/path.webp',
    'images/../secret.webp',
    '',
  ])('آدرس غیرمجاز %s', value => {
    expect(isSafeMediaReference(value)).toBe(false);
  });
});

describe('buildSliderProduct', () => {
  const red = { id: 1, name: 'قرمز', hexCode: '#f00' };
  const blue = { id: 2, name: 'آبی', hexCode: '#00f' };

  const product = {
    id: 7,
    title: 'کت شلوار',
    slug: 'suit',
    image: 'images/cover.webp',
    variants: [
      { price: '12000000', stock: 0, colorId: 1, color: red },
      { price: '14500000', stock: 2, colorId: 2, color: blue },
      { price: '13000000', stock: 0, colorId: 2, color: blue },
    ],
    colorImages: [
      { url: 'images/red.webp', color: red },
      { url: 'images/blue.webp', color: blue },
      { url: 'images/blue2.webp', color: blue },
    ],
  };

  it('با انتخاب رنگ، تصویر و کمترین قیمت همان رنگ را برمی‌گرداند', () => {
    const result = buildSliderProduct(product, 2);

    expect(result.price).toBe(13000000);
    expect(result.image).toBe('images/blue.webp');
    expect(result.inStock).toBe(true);
  });

  it('بدون انتخاب رنگ، تصویر اول و کمترین قیمت کل محصول را می‌دهد', () => {
    const result = buildSliderProduct(product);

    expect(result.price).toBe(12000000);
    expect(result.image).toBe('images/red.webp');
  });

  it('گزینه‌های رنگ را با تصویر/قیمت/موجودی همان رنگ برمی‌گرداند', () => {
    const result = buildSliderProduct(product);

    expect(result.colorOptions).toEqual([
      {
        colorId: 1,
        name: 'قرمز',
        hexCode: '#f00',
        image: 'images/red.webp',
        price: 12000000,
        inStock: false,
      },
      {
        colorId: 2,
        name: 'آبی',
        hexCode: '#00f',
        image: 'images/blue.webp',
        price: 13000000,
        inStock: true,
      },
    ]);
  });

  it('رنگی که فقط واریانت دارد (بدون تصویر) هم اضافه می‌شود', () => {
    const result = buildSliderProduct({
      id: 9,
      title: 'پیراهن',
      slug: 'shirt',
      image: 'images/shirt.webp',
      variants: [{ price: 900000, stock: 3, colorId: 5, color: red }],
      colorImages: [],
    });

    expect(result.colorOptions).toEqual([
      {
        colorId: 5,
        name: 'قرمز',
        hexCode: '#f00',
        image: 'images/shirt.webp',
        price: 900000,
        inStock: true,
      },
    ]);
  });

  it('محصول بدون واریانت قیمت صفر می‌گیرد', () => {
    const result = buildSliderProduct({ id: 1, title: 'x', slug: 'x' });

    expect(result.price).toBe(0);
    expect(result.image).toBeNull();
    expect(result.colorOptions).toEqual([]);
  });
});

describe('hydrateBlocksWithProducts', () => {
  const blocks = [
    {
      id: 1,
      type: BlogBlockType.Content,
      order: 0,
      title: null,
      settings: null,
      items: null,
    },
    {
      id: 2,
      type: BlogBlockType.Slider,
      order: 1,
      title: 'محصولات مرتبط',
      settings: null,
      items: [{ productId: 3 }, { productId: 999 }],
    },
  ];

  it('اطلاعات محصول موجود را اضافه و محصول حذف‌شده را null می‌کند', () => {
    const hydrated = hydrateBlocksWithProducts(
      blocks,
      new Map([
        [
          3,
          {
            id: 3,
            title: 'پیراهن',
            slug: 'shirt',
            image: 'images/shirt.webp',
            variants: [{ price: 500000, stock: 4, colorId: 1 }],
            colorImages: [],
          },
        ],
      ]),
    );

    const slider = hydrated.find(block => block.type === BlogBlockType.Slider);

    expect(slider?.items?.[0].product?.title).toBe('پیراهن');
    expect(slider?.items?.[0].product?.inStock).toBe(true);
    expect(slider?.items?.[1].product).toBeNull();
  });

  it('بلوک‌های غیر اسلایدر را دست‌نخورده برمی‌گرداند', () => {
    const hydrated = hydrateBlocksWithProducts(blocks, new Map());

    expect(hydrated[0]).toBe(blocks[0]);
  });
});
