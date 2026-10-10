import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { coerceOptionalBoolean } from 'src/common/utils/coerce-optional-boolean';

export class CreateBlogPostDto {
  @ApiProperty()
  @IsString()
  title: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  excerpt?: string;

  /** متا تایتل سئو (اختیاری — در صورت خالی بودن، عنوان مقاله استفاده می‌شود) */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  metaTitle?: string;

  /** متا دیسکریپشن سئو (اختیاری — در صورت خالی بودن، خلاصه‌ی مقاله استفاده می‌شود) */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  metaDescription?: string;

  /** ایندکس شدن صفحه‌ی مقاله در گوگل (پیش‌فرض: بله) */
  @ApiProperty({
    required: false,
    default: true,
    description: 'false یعنی صفحه‌ی مقاله با تگ noindex منتشر می‌شود',
  })
  @IsOptional()
  @Transform(({ value }) => coerceOptionalBoolean(value))
  @IsBoolean()
  indexable?: boolean;

  /** دنبال شدن لینک‌های صفحه‌ی مقاله توسط خزنده‌ها (پیش‌فرض: بله) */
  @ApiProperty({
    required: false,
    default: true,
    description: 'false یعنی تگ nofollow روی صفحه‌ی مقاله اعمال می‌شود',
  })
  @IsOptional()
  @Transform(({ value }) => coerceOptionalBoolean(value))
  @IsBoolean()
  followable?: boolean;

  @ApiProperty()
  @IsString()
  content: string;

  @ApiProperty()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isPublished?: boolean;

  @ApiProperty()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isFeatured?: boolean;
}
