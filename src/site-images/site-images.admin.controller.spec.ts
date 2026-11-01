/**
 * uuid نسخه‌ی نصب‌شده ESM-only است و در محیط CJS تست قابل import نیست؛
 * اینجا با یک شمارنده‌ی ساده ماک می‌شود تا نام فایل‌ها قابل پیش‌بینی باشد.
 */
jest.mock('uuid', () => {
  let counter = 0;
  return { v4: () => `site-image-${(counter += 1)}` };
});

import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { ResponseInterceptor } from 'src/common/interceptors/response.interceptor';
import { FilesService } from 'src/files/files.service';
import request from 'supertest';

import { SiteImage } from './entities/site-image.entity';
import { SiteImagesAdminController } from './site-images.admin.controller';
import { SiteImagesService } from './site-images.service';

/**
 * تست API مدیریت تصاویر صفحه اصلی.
 *
 * مهم‌ترین رفتارها:
 * - تصویر موبایل اختیاری است (فقط دسکتاپ کافی است)
 * - جایگاه ناشناخته رد می‌شود
 * - فقط فایل دسکتاپ/موبایل در پوشه‌ی uploads نوشته می‌شود
 */
describe('Admin site images API', () => {
  let app: INestApplication;
  const writtenFiles: string[] = [];
  const rows: SiteImage[] = [];

  /** مخزن درون‌حافظه‌ای تا تست به دیتابیس واقعی نیاز نداشته باشد */
  const repo = {
    find: jest.fn(({ where }: any = {}) =>
      Promise.resolve(
        rows.filter(row => (where?.isActive ? row.isActive : true)),
      ),
    ),
    findOne: jest.fn(({ where }: any) =>
      Promise.resolve(rows.find(row => row.slot === where.slot) ?? null),
    ),
    create: jest.fn((value: Partial<SiteImage>) => ({ ...value })),
    save: jest.fn((value: SiteImage) => {
      const index = rows.findIndex(row => row.slot === value.slot);

      const saved = {
        id: index >= 0 ? rows[index].id : rows.length + 1,
        isActive: true,
        updatedAt: new Date(),
        ...value,
      };

      if (index >= 0) {
        rows[index] = saved;
      } else {
        rows.push(saved);
      }

      return Promise.resolve(saved);
    }),
    remove: jest.fn((value: SiteImage) => {
      const index = rows.findIndex(row => row.slot === value.slot);

      if (index >= 0) rows.splice(index, 1);

      return Promise.resolve(value);
    }),
  };

  const trackUrl = (url?: string | null) => {
    if (!url) return;

    const absolute = join(process.cwd(), 'uploads', url);

    writtenFiles.push(absolute);

    return absolute;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SiteImagesAdminController],
      providers: [
        SiteImagesService,
        FilesService,
        { provide: getRepositoryToken(SiteImage), useValue: repo },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));

    await app.init();
  });

  afterAll(async () => {
    await app.close();

    for (const file of writtenFiles) {
      if (existsSync(file)) unlinkSync(file);
    }
  });

  it('ذخیره‌ی جایگاه با تصویر دسکتاپ تنها (موبایل اختیاری)', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/admin/site-images/home.sale-banner')
      .field('alt', 'بنر فروش ویژه')
      .field('linkUrl', '/products')
      .field('isActive', 'true')
      .attach('desktop', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'banner.webp',
        contentType: 'image/webp',
      })
      .expect(200);

    const data = response.body.data;

    expect(data.slot).toBe('home.sale-banner');
    expect(data.desktop).toMatch(/^site-image-\d+\.webp$/);
    expect(data.mobile).toBeNull();
    expect(data.alt).toBe('بنر فروش ویژه');
    expect(data.linkUrl).toBe('/products');

    expect(existsSync(trackUrl(data.desktop))).toBe(true);
  });

  it('تصویر موبایل هم ذخیره می‌شود، ولی دسکتاپ اختیاری نیست و حفظ می‌شود', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/admin/site-images/home.sale-banner')
      .attach('mobile', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'banner-mobile.webp',
        contentType: 'image/webp',
      })
      .expect(200);

    const data = response.body.data;

    // تصویر دسکتاپ قبلی حفظ شده و موبایل اضافه شده است
    expect(data.desktop).toMatch(/^site-image-\d+\.webp$/);
    expect(data.mobile).toMatch(/^site-image-\d+\.webp$/);

    expect(existsSync(trackUrl(data.mobile))).toBe(true);
  });

  it('جایگاه ناشناخته رد می‌شود', async () => {
    await request(app.getHttpServer())
      .put('/api/admin/site-images/home.unknown')
      .field('alt', 'x')
      .expect(400);
  });

  it('بدون تصویر دسکتاپ در اولین ذخیره، خطای ۴۰۰ برمی‌گردد', async () => {
    await request(app.getHttpServer())
      .put('/api/admin/site-images/home.category-1')
      .field('alt', 'دسته‌بندی')
      .expect(400);
  });
});
