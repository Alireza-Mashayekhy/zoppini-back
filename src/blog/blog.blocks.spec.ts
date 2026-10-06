/**
 * uuid (نسخه‌ی ESM) در محیط CJS تست قابل import نیست، پس ماژول فایل‌ها
 * ماک می‌شود؛ این تست فقط API بخش‌های مقاله را می‌سنجد.
 */
jest.mock('src/files/files.service', () => ({
  FilesService: class FilesService {},
}));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Product } from 'src/products/entities/product.entity';
import request from 'supertest';

import { BlogService } from './blog.service';
import { BlogAdminController } from './blog.admin.controller';
import { BlogBlock } from './entities/blog-block.entity';
import { BlogPost } from './entities/blog-post.entity';
import { FilesService } from 'src/files/files.service';
import { ResponseInterceptor } from 'src/common/interceptors/response.interceptor';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';

/**
 * تست یکپارچه‌ی API بخش‌های مقاله.
 *
 * دیتابیس واقعی در CI این پروژه در دسترس نیست، پس ریپازیتوری‌ها ماک
 * شده‌اند ولی مسیر HTTP، اعتبارسنجی DTO، ترتیب بخش‌ها و شکل پاسخ
 * (همان چیزی که پنل ادمین و سایت مصرف می‌کنند) واقعاً اجرا می‌شود.
 */
describe('Blog blocks API', () => {
  let app: INestApplication;

  const post = {
    id: 5,
    title: 'راهنمای انتخاب کت شلوار',
    slug: 'suit-guide',
    content: '<h2>مقدمه</h2>',
    isPublished: true,
  };

  /** رکوردهایی که در حافظه به‌عنوان بلوک‌های ذخیره‌شده نگه داشته می‌شوند */
  let storedBlocks: any[] = [];

  const managerMock = {
    delete: jest.fn(async () => {
      storedBlocks = [];
      return { affected: 1 };
    }),
    create: jest.fn((_entity: unknown, data: any) => ({ ...data })),
    save: jest.fn(async (rows: any[]) => {
      storedBlocks = rows;
      return rows;
    }),
  };

  const blockRepository = {
    manager: { transaction: jest.fn(async (callback: any) => callback(managerMock)) },
    find: jest.fn(async () => storedBlocks.map((row, index) => ({ id: index + 1, ...row }))),
  };

  const blogRepository = {
    findOne: jest.fn(async ({ where }: any) =>
      where.id === post.id ? { ...post } : null,
    ),
  };

  const productRepository = {
    find: jest.fn(async () => [
      {
        id: 3,
        title: 'کت شلوار کلاسیک',
        slug: 'classic-suit',
        image: 'images/cover.webp',
        variants: [
          { price: '9800000', stock: 2, colorId: 1, color: { id: 1, name: 'مشکی', hexCode: '#000' } },
        ],
        colorImages: [
          { url: 'images/black.webp', color: { id: 1, name: 'مشکی', hexCode: '#000' } },
        ],
      },
    ]),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BlogAdminController],
      providers: [
        BlogService,
        { provide: getRepositoryToken(BlogPost), useValue: blogRepository },
        { provide: getRepositoryToken(BlogBlock), useValue: blockRepository },
        { provide: getRepositoryToken(Product), useValue: productRepository },
        { provide: FilesService, useValue: { saveFile: jest.fn() } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();

    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('بخش‌ها را با ترتیب دلخواه ادمین ذخیره و همان ترتیب را برمی‌گرداند', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/admin/blog/5/blocks')
      .send({
        blocks: [
          { type: 'toc', title: 'فهرست این مطلب' },
          { type: 'slider', items: [{ productId: 3, colorId: 1, badge: 'جدید' }] },
          { type: 'content' },
          {
            type: 'faq',
            title: 'سوالات پرتکرار',
            items: [{ question: 'چطور سایز را انتخاب کنم؟', answer: 'جدول سایز...' }],
          },
        ],
      })
      .expect(200);

    const blocks = response.body.data;

    expect(blocks.map((block: any) => block.type)).toEqual([
      'toc',
      'slider',
      'content',
      'faq',
    ]);

    expect(blocks.map((block: any) => block.order)).toEqual([0, 1, 2, 3]);

    // عنوان دلخواه ادمین حفظ می‌شود
    expect(blocks[0].title).toBe('فهرست این مطلب');
    expect(blocks[3].title).toBe('سوالات پرتکرار');

    // آیتم اسلایدر با اطلاعات محصول (تصویر/قیمت/رنگ) هیدراته می‌شود
    const sliderItem = blocks[1].items[0];
    expect(sliderItem.product).toMatchObject({
      id: 3,
      title: 'کت شلوار کلاسیک',
      image: 'images/black.webp',
      price: 9800000,
      inStock: true,
    });
    expect(sliderItem.product.colorOptions[0]).toMatchObject({
      colorId: 1,
      name: 'مشکی',
      price: 9800000,
    });
  });

  it('اگر بخش متن اصلی فرستاده نشود، خودش به ابتدای مقاله اضافه می‌شود', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/admin/blog/5/blocks')
      .send({ blocks: [{ type: 'faq', items: [{ question: 'س؟', answer: 'ج' }] }] })
      .expect(200);

    expect(response.body.data.map((block: any) => block.type)).toEqual([
      'content',
      'faq',
    ]);
  });

  it('آیتم‌های خالی (ادمین نیمه‌کاره رها کرده) ذخیره نمی‌شوند', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/admin/blog/5/blocks')
      .send({
        blocks: [
          { type: 'content' },
          {
            type: 'faq',
            items: [
              { question: '', answer: '' },
              { question: 'سوال واقعی', answer: 'پاسخ واقعی' },
            ],
          },
          { type: 'slider', items: [{ badge: 'بدون محصول' }] },
        ],
      })
      .expect(200);

    const blocks = response.body.data;

    expect(blocks.find((block: any) => block.type === 'faq').items).toHaveLength(1);
    expect(blocks.find((block: any) => block.type === 'slider').items).toEqual([]);
  });

  it('سوال بدون پاسخ را با خطای ۴۰۰ رد می‌کند', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/admin/blog/5/blocks')
      .send({ blocks: [{ type: 'faq', items: [{ question: 'فقط سوال' }] }] })
      .expect(400);

    expect(response.body.message).toContain('سوال و پاسخ');
  });

  it('نوع بخش ناشناخته و دومین بخش متن اصلی را رد می‌کند', async () => {
    await request(app.getHttpServer())
      .put('/api/admin/blog/5/blocks')
      .send({ blocks: [{ type: 'gallery' }] })
      .expect(400);

    await request(app.getHttpServer())
      .put('/api/admin/blog/5/blocks')
      .send({ blocks: [{ type: 'content' }, { type: 'content' }] })
      .expect(400);
  });

  it('مقاله‌ی ناموجود را ۴۰۴ برمی‌گرداند', async () => {
    await request(app.getHttpServer())
      .put('/api/admin/blog/999/blocks')
      .send({ blocks: [{ type: 'content' }] })
      .expect(404);
  });

  it('بخش‌های ذخیره‌شده را برمی‌گرداند', async () => {
    storedBlocks = [
      {
        postId: 5,
        type: 'content',
        order: 0,
        title: null,
        settings: null,
        items: null,
      },
      {
        postId: 5,
        type: 'media',
        order: 1,
        title: null,
        settings: null,
        items: [{ mediaType: 'video', url: 'videos/a.mp4', poster: 'images/p.webp' }],
      },
    ];

    const response = await request(app.getHttpServer())
      .get('/api/admin/blog/5/blocks')
      .expect(200);

    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[1].items[0]).toMatchObject({
      mediaType: 'video',
      url: 'videos/a.mp4',
    });
  });
});
