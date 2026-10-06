import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { BlogBlockType } from '../entities/blog-block.entity';
import type { BlogMediaType } from '../entities/blog-block.entity';

export class BlogBlockItemDto {
  @ApiPropertyOptional({ description: 'محتوای HTML (بلوک متن)' })
  @IsOptional()
  @IsString()
  @MaxLength(500000)
  html?: string;

  @ApiPropertyOptional({ description: 'متن سوال (بلوک سوالات متداول)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  question?: string;

  @ApiPropertyOptional({ description: 'متن پاسخ (بلوک سوالات متداول)' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  answer?: string;

  @ApiPropertyOptional({ enum: ['image', 'video'] })
  @IsOptional()
  @IsEnum(['image', 'video'])
  mediaType?: BlogMediaType;

  @ApiPropertyOptional({ description: 'نام فایل آپلودشده یا URL کامل' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  url?: string;

  @ApiPropertyOptional({ description: 'پوستر ویدیو' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  poster?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  alt?: string;

  @ApiPropertyOptional({ description: 'شناسه محصول (بلوک اسلایدر)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  productId?: number;

  @ApiPropertyOptional({ description: 'شناسه رنگ محصول (اختیاری)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  colorId?: number;

  @ApiPropertyOptional({ description: 'برچسب روی کارت محصول' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  badge?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  caption?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  linkUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  linkLabel?: string;
}

export class BlogBlockSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoplay?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  title?: string;
}

export class BlogBlockDto {
  @ApiProperty({ enum: BlogBlockType })
  @IsEnum(BlogBlockType)
  type: BlogBlockType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  title?: string;

  @ApiPropertyOptional({ type: BlogBlockSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BlogBlockSettingsDto)
  settings?: BlogBlockSettingsDto;

  @ApiPropertyOptional({ type: [BlogBlockItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BlogBlockItemDto)
  items?: BlogBlockItemDto[];
}

export class SaveBlogBlocksDto {
  @ApiProperty({ type: [BlogBlockDto], description: 'ترتیب آرایه = ترتیب نمایش' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BlogBlockDto)
  blocks: BlogBlockDto[];
}
