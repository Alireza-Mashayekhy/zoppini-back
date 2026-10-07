import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

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
