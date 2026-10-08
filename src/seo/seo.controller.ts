import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { SeoService } from './seo.service';

/**
 * اندپوینت‌های عمومی سئو.
 *
 * فرانت‌اند (سرور‌ساید، داخل `generateMetadata`) متای هر صفحه را از
 * `GET /seo/page?path=/about-us` می‌خواند.
 *
 * محدودیت نرخ درخواست برای این کنترلر غیرفعال است؛ چون درخواست‌ها از سمت
 * سرور فرانت‌اند (بازتولید صفحات استاتیک) می‌آید و نباید ۴۲۹ بخورد.
 */
@SkipThrottle()
@Controller('seo')
export class SeoController {
  constructor(private readonly seoService: SeoService) {}

  /** متای یک صفحه بر اساس مسیر آن */
  @Get('page')
  findPage(@Query('path') path?: string) {
    if (!path) {
      throw new BadRequestException('پارامتر path الزامی است');
    }

    return this.seoService.findByPath(path);
  }

  /** متای یک صفحه بر اساس شناسه */
  @Get('page/:id')
  findOne(@Param('id') id: string) {
    return this.seoService.findOne(+id);
  }

  /** لیست همه‌ی صفحات به همراه متای آن‌ها */
  @Get('pages')
  findAll() {
    return this.seoService.findAll({ all: true, page: 1, limit: 500 });
  }

  /**
   * ریدایرکت 301 ثبت‌شده برای یک مسیر.
   * اگر ریدایرکتی ثبت نشده باشد، `data` برابر `null` است.
   */
  @Get('redirect')
  findRedirect(@Query('path') path?: string) {
    if (!path) {
      throw new BadRequestException('پارامتر path الزامی است');
    }

    return this.seoService.findRedirectByPath(path);
  }

  /** همه‌ی ریدایرکت‌های 301 ثبت‌شده (برای proxy فرانت‌اند) */
  @Get('redirects')
  findAllRedirects() {
    return this.seoService.findAllRedirects();
  }
}
