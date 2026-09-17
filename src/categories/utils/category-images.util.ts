import { BadRequestException } from '@nestjs/common';
import { Express } from 'express';
import { FileSizeValidationPipe } from 'src/files/validation/fileSize.validator';

/** حداکثر تعداد تصویر دوم برای هر دسته‌بندی */
export const CATEGORY_MAX_SECOND_IMAGES = 2;

/**
 * نام فیلدهای multipart/form-data برای تصویرهای دسته‌بندی.
 *
 * maxCount فیلد `secondImages` عمداً یکی بیشتر از حد مجاز است تا وقتی ادمین
 * بیشتر از ۲ عکس می‌فرستد، به‌جای خطای فنی multer (LIMIT_UNEXPECTED_FILE)
 * پیام فارسی و واضح برگردانیم.
 */
export const CATEGORY_IMAGE_FIELDS = [
  { name: 'file', maxCount: 1 },
  { name: 'secondImages', maxCount: CATEGORY_MAX_SECOND_IMAGES + 1 },
] as const;

/** خروجی FileFieldsInterceptor برای فیلدهای بالا */
export type CategoryImageUploads = {
  /** تصویر اصلی */
  file?: Express.Multer.File[];
  /** تصویرهای دوم (حداکثر ۲ تا) */
  secondImages?: Express.Multer.File[];
};

/** تصویرهای اعتبارسنجی‌شده که به سرویس دسته‌بندی‌ها داده می‌شود */
export type CategoryImages = {
  /** تصویر اصلی — فیلد `file` */
  primary?: Express.Multer.File;
  /** تصویرهای دوم — فیلد `secondImages` */
  second?: Express.Multer.File[];
};

// همان قوانین بقیهٔ آپلودها: حداکثر 2MB و فقط jpeg/png/webp
const fileSizeValidationPipe = new FileSizeValidationPipe({ optional: true });

export interface PickCategoryImagesOptions {
  /**
   * اگر true باشد، نبودِ تصویر اصلی خطا می‌دهد (مثل ساخت دسته‌بندی جدید).
   */
  requirePrimary?: boolean;
}

/**
 * فایل‌های آپلودشده را از فیلدهای `file` و `secondImages` بیرون می‌کشد و
 * اعتبارسنجی می‌کند.
 *
 * فیلدی که ارسال نشده باشد خالی می‌ماند، یعنی «تغییر نکرد» (در ویرایش) یا
 * «بدون تصویر» (در ساخت).
 */
export function pickCategoryImages(
  uploads?: CategoryImageUploads,
  options: PickCategoryImagesOptions = {},
): CategoryImages {
  const primary = fileSizeValidationPipe.transform(uploads?.file?.[0]);

  if (options.requirePrimary && !primary) {
    throw new BadRequestException('فایل آپلود نشده است.');
  }

  const second = (uploads?.secondImages ?? [])
    .map(file => fileSizeValidationPipe.transform(file))
    .filter((file): file is Express.Multer.File => Boolean(file));

  if (second.length > CATEGORY_MAX_SECOND_IMAGES) {
    throw new BadRequestException(
      `حداکثر ${CATEGORY_MAX_SECOND_IMAGES} تصویر دوم برای هر دسته‌بندی مجاز است.`,
    );
  }

  return { primary, second };
}
