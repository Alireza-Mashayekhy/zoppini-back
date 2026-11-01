import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { coerceOptionalBoolean } from 'src/common/utils/coerce-optional-boolean';

/**
 * داده‌های متنی ویرایش یک جایگاه تصویر صفحه اصلی.
 *
 * فایل‌ها (تصویر دسکتاپ/موبایل) جداگانه با `multipart/form-data` می‌آیند و
 * اعتبارسنجی‌شان با `FileSizeValidationPipe` انجام می‌شود.
 */
export class UpdateSiteImageDto {
  /** متن جایگزین تصویر (alt) */
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'متن جایگزین حداکثر ۲۵۵ کاراکتر است' })
  alt?: string;

  /**
   * لینک کلیک روی تصویر؛ خالی یعنی بدون لینک.
   * یا مسیر داخلی سایت (`/products`) یا آدرس کامل `http(s)://…`
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Matches(/^$|^\/[^/\\]|^https?:\/\/./i, {
    message: 'لینک باید با / شروع شود یا یک آدرس معتبر http(s) باشد',
  })
  linkUrl?: string;

  /** نمایش تصویر آپلودشده روی سایت (خاموش = بازگشت به تصویر پیش‌فرض) */
  @IsOptional()
  @Transform(({ value }) => coerceOptionalBoolean(value))
  @IsBoolean()
  isActive?: boolean;

  /** حذف تصویر موبایل و بازگشت به تصویر دسکتاپ */
  @IsOptional()
  @Transform(({ value }) => coerceOptionalBoolean(value))
  @IsBoolean()
  removeMobile?: boolean;
}
