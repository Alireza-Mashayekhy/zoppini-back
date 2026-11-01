import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { SiteImagesService } from './site-images.service';

/**
 * تصاویر صفحه اصلی سایت.
 *
 * فرانت‌اند (سمت سرور، هنگام ساخت صفحه‌ی اصلی) این لیست را می‌خواند و هر
 * جایگاه را با تصویر پیش‌فرض خودش ادغام می‌کند؛ پس اگر مدیری چیزی آپلود
 * نکرده باشد، سایت مثل قبل نمایش داده می‌شود.
 *
 * محدودیت نرخ درخواست غیرفعال است چون درخواست از سرور فرانت‌اند
 * (بازتولید صفحات) می‌آید و نباید ۴۲۹ بخورد.
 */
@SkipThrottle()
@Controller('site-images')
export class SiteImagesController {
  constructor(private readonly siteImagesService: SiteImagesService) {}

  /** تصاویر فعال صفحه اصلی */
  @Get()
  findAll() {
    return this.siteImagesService.findActive();
  }
}
