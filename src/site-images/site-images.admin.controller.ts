import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { UPLOAD_PRESETS } from 'src/files/upload-presets';
import { FileSizeValidationPipe } from 'src/files/validation/fileSize.validator';

import { UpdateSiteImageDto } from './dto/update-site-image.dto';
import { SiteImagesService } from './site-images.service';

/**
 * مدیریت تصاویر صفحه اصلی از پنل ادمین.
 *
 * برای هر جایگاه (بنر فروش ویژه، تصاویر دسته‌بندی و پوستر ویدیوها) می‌توان
 * تصویر دسکتاپ و موبایل + متن جایگزین (alt) و لینک را ثبت کرد. تصویر
 * موبایل اختیاری است؛ اگر آپلود نشود، همان تصویر دسکتاپ روی موبایل
 * نمایش داده می‌شود.
 *
 * نقش‌های مجاز مثل بخش سئوی صفحات است: مدیر و کارشناس سئو.
 */
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin, Role.Seo)
@Controller('admin/site-images')
export class SiteImagesAdminController {
  constructor(private readonly siteImagesService: SiteImagesService) {}

  /** همه‌ی جایگاه‌هایی که مدیر تا حالا ذخیره کرده است */
  @Get()
  findAll() {
    return this.siteImagesService.findAll();
  }

  /**
   * ذخیره‌ی تصویر یک جایگاه (ساخت یا به‌روزرسانی).
   *
   * فیلدهای فرم: `desktop` (اختیاری بعد از اولین بار)، `mobile` (اختیاری)،
   * `alt`، `linkUrl`، `isActive`، `removeMobile`.
   */
  @Put(':slot')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'desktop', maxCount: 1 },
        { name: 'mobile', maxCount: 1 },
      ],
      {
        storage: memoryStorage(),
        limits: { fileSize: UPLOAD_PRESETS.image.maxSize },
      },
    ),
  )
  upsert(
    @Param('slot') slot: string,
    @Body() dto: UpdateSiteImageDto,
    @UploadedFiles()
    files: { desktop?: Express.Multer.File[]; mobile?: Express.Multer.File[] },
  ) {
    return this.siteImagesService.upsert(slot, dto, {
      desktop: this.validateImage(files?.desktop?.[0]),
      mobile: this.validateImage(files?.mobile?.[0]),
    });
  }

  /** حذف تصویرهای آپلودی جایگاه و بازگشت به تصویر پیش‌فرض سایت */
  @Delete(':slot')
  reset(@Param('slot') slot: string) {
    return this.siteImagesService.reset(slot);
  }

  /**
   * اعتبارسنجی تک‌فایل با همان قواعد بقیه‌ی آپلودهای تصویر
   * (فرمت و حجم). فایل خالی یعنی «تغییر نکرده».
   */
  private validateImage(file?: Express.Multer.File) {
    if (!file || file.size === 0) return undefined;

    return new FileSizeValidationPipe({ optional: true }).transform(file);
  }
}
