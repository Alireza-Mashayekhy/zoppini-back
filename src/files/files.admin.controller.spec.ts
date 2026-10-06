/**
 * uuid نسخه‌ی نصب‌شده ESM-only است و در محیط CJS تست قابل import نیست؛
 * اینجا با یک شمارنده‌ی ساده ماک می‌شود تا نام فایل‌ها هم قابل پیش‌بینی باشد.
 */
jest.mock('uuid', () => {
  let counter = 0;
  return { v4: () => `test-uuid-${(counter += 1)}` };
});

import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { ResponseInterceptor } from 'src/common/interceptors/response.interceptor';
import request from 'supertest';

import { FilesAdminController } from './files.admin.controller';
import { FilesService } from './files.service';

/**
 * تست آپلود مدیا از سیستم ادمین (ادیتور متن، گالری مقاله و پوستر ویدیو).
 *
 * فایل واقعاً روی دیسک نوشته می‌شود و در پایان تست پاک می‌گردد.
 */
describe('Admin media upload API', () => {
  let app: INestApplication;
  const writtenFiles: string[] = [];

  const trackFile = (relativeUrl: string) => {
    const absolute = join(process.cwd(), 'uploads', relativeUrl);
    writtenFiles.push(absolute);
    return absolute;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FilesAdminController],
      providers: [FilesService],
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

    // فایل‌های تستی که روی دیسک نوشته شده‌اند پاک می‌شوند
    for (const file of writtenFiles) {
      if (existsSync(file)) unlinkSync(file);
    }
  });

  it('تصویر را ذخیره می‌کند و مسیر نسبی + نام فایل را برمی‌گرداند', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/admin/files/image')
      .attach('images', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'cover.png',
        contentType: 'image/png',
      })
      .expect(201);

    const data = response.body.data;

    expect(data.url).toMatch(/^images\/test-uuid-\d+\.png$/);
    expect(data.filenames).toHaveLength(1);
    expect(existsSync(trackFile(data.url))).toBe(true);
  });

  it('چند تصویر را با هم می‌پذیرد (ادیتور متن چندتایی آپلود می‌کند)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/admin/files/image')
      .attach('images', Buffer.from([1, 2, 3]), {
        filename: 'a.jpg',
        contentType: 'image/jpeg',
      })
      .attach('images', Buffer.from([4, 5, 6]), {
        filename: 'b.webp',
        contentType: 'image/webp',
      })
      .expect(201);

    const data = response.body.data;

    expect(data.filenames).toHaveLength(2);
    expect(data.urls[0]).toMatch(/^images\/.+\.jpg$/);
    data.urls.forEach((url: string) => expect(existsSync(trackFile(url))).toBe(true));
  });

  it('ویدیو را در پوشه‌ی videos ذخیره می‌کند', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/admin/files/video')
      .attach('videos', Buffer.from([0, 0, 0, 24]), {
        filename: 'clip.mp4',
        contentType: 'video/mp4',
      })
      .expect(201);

    const data = response.body.data;

    expect(data.url).toMatch(/^videos\/test-uuid-\d+\.mp4$/);
    expect(existsSync(trackFile(data.url))).toBe(true);
  });

  it('فرمت غیرمجاز را رد می‌کند', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/admin/files/image')
      .attach('images', Buffer.from([1, 2, 3]), {
        filename: 'payload.exe',
        contentType: 'application/x-msdownload',
      });

    expect(response.status).toBe(400);
  });

  it('ویدیوی با فرمت غیرمجاز را رد می‌کند', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/admin/files/video')
      .attach('videos', Buffer.from([1, 2, 3]), {
        filename: 'clip.mkv',
        contentType: 'video/x-matroska',
      });

    expect(response.status).toBe(400);
  });

  it('تصویر بزرگ‌تر از سقف حجم را رد می‌کند', async () => {
    const tooLarge = Buffer.alloc(6 * 1024 * 1024, 1);

    const response = await request(app.getHttpServer())
      .post('/api/admin/files/image')
      .attach('images', tooLarge, {
        filename: 'big.png',
        contentType: 'image/png',
      });

    expect([400, 413]).toContain(response.status);
  });

  it('ارسال بدون فایل را رد می‌کند', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/admin/files/image')
      .expect(400);

    expect(response.body.message).toBeTruthy();
  });
});
