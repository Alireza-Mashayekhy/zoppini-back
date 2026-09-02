import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

export interface FileSizeValidationOptions {
  /**
   * اگر true باشد، ارسال‌نشدن فایل خطا نمی‌دهد و undefined برمی‌گردد.
   * برای endpointهای ویرایش که تصویرشان اختیاری است استفاده می‌شود
   * (مثلاً ادیت محصول بدون عوض‌کردن عکس).
   */
  optional?: boolean;
}

@Injectable()
export class FileSizeValidationPipe implements PipeTransform {
  private readonly maxSize = 1024 * 1024 * 2; //2 MB
  private readonly allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];

  constructor(private readonly options: FileSizeValidationOptions = {}) {}

  transform(file?: Express.Multer.File): Express.Multer.File | undefined {
    /**
     * در حالت اختیاری، فایل ارسال‌نشده (یا فایل خالی) به معنی
     * «تصویر تغییر نکرده» است، نه خطا.
     */
    if (!file || (this.options.optional && file.size === 0)) {
      if (this.options.optional) {
        return undefined;
      }

      throw new BadRequestException('فایل آپلود نشده است.');
    }

    if (file.size > this.maxSize) {
      throw new BadRequestException(
        `حجم فایل نباید بیشتر از . ${this.maxSize / (1024 * 1024)}MB باشید`,
      );
    }

    if (!this.allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException('فرمت فایل مجاز نیست. فقط jpeg, png, webp');
    }

    return file;
  }
}
