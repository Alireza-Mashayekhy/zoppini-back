import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * طبق مستند اسنپ‌پی، Cancel و Update برگشت‌ناپذیرند و قبل از ارسال
 * درخواست باید تأییدیهٔ ادمین گرفته شود؛ به همین دلیل در هر دو DTO
 * فیلد `confirm` باید صراحتاً true ارسال شود.
 */
export class SnappayAdminCancelDto {
  @IsBoolean()
  confirm: boolean;

  /** بعد از لغو موفق سمت اسنپ‌پی، سفارش هم از مسیر موجود ادمین لغو شود؟ (پیش‌فرض: بله) */
  @IsOptional()
  @IsBoolean()
  cancelOrder?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class SnappayAdminUpdateItemDto {
  /** شناسهٔ قلم سفارش (OrderItem.id)؛ همان شناسه‌ای که به اسنپ‌پی ارسال شده است */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orderItemId: number;

  /** تعداد باقی‌ماندهٔ این قلم؛ صفر یعنی حذف کامل قلم از سفارش اسنپ‌پی */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  count: number;
}

export class SnappayAdminUpdateDto {
  @IsBoolean()
  confirm: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SnappayAdminUpdateItemDto)
  items: SnappayAdminUpdateItemDto[];
}
