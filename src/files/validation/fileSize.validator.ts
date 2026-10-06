import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import * as path from 'path';

import {
  allowedExtensionsLabel,
  UPLOAD_PRESETS,
  UploadKind,
} from '../upload-presets';

export interface FileSizeValidationOptions {
  /**
   * اگر true باشد، ارسال‌نشدن فایل خطا نمی‌دهد و undefined برمی‌گردد.
   * برای endpointهای ویرایش که تصویرشان اختیاری است استفاده می‌شود
   * (مثلاً ادیت محصول بدون عوض‌کردن عکس).
   */
  optional?: boolean;

  /**
   * نوع فایل: image | video | audio
   * (پیش‌فرض image — رفتار قبلی را حفظ می‌کند)
   */
  kind?: UploadKind;
}

@Injectable()
export class FileSizeValidationPipe implements PipeTransform {
  private readonly preset;
  private readonly optional: boolean;

  constructor(private readonly options: FileSizeValidationOptions = {}) {
    this.preset = UPLOAD_PRESETS[options.kind ?? 'image'];
    this.optional = options.optional ?? false;
  }

  transform(file?: Express.Multer.File): Express.Multer.File | undefined {
    /**
     * در حالت اختیاری، فایل ارسال‌نشده (یا فایل خالی) به معنی
     * «تصویر تغییر نکرده» است، نه خطا.
     */
    if (!file || (this.optional && file.size === 0)) {
      if (this.optional) {
        return undefined;
      }

      throw new BadRequestException('فایل آپلود نشده است.');
    }

    if (file.size > this.preset.maxSize) {
      throw new BadRequestException(
        `حجم ${this.preset.label} نباید بیشتر از ${this.preset.maxSize / (1024 * 1024)}MB باشد`,
      );
    }

    const ext = path.extname(file.originalname || '').toLowerCase();

    if (!this.preset.extensions.includes(ext)) {
      throw new BadRequestException(
        `فرمت فایل مجاز نیست. فرمت‌های مجاز: ${allowedExtensionsLabel(this.preset)}`,
      );
    }

    /**
     * بعضی مرورگرها (مخصوصاً روی موبایل) mime درست نمی‌فرستند؛
     * پس فقط اگر mime مشخص و نامرتبط بود خطا می‌دهیم.
     */
    const mime = (file.mimetype || '').toLowerCase();
    if (
      mime &&
      mime !== 'application/octet-stream' &&
      !this.preset.mimes.includes(mime)
    ) {
      throw new BadRequestException(
        `فرمت فایل مجاز نیست. فرمت‌های مجاز: ${allowedExtensionsLabel(this.preset)}`,
      );
    }

    return file;
  }
}
