import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class PromotionSuggestionsQueryDto {
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  variantIds?: number[];
}

/** شبیه‌سازی یک پروموشن با سبد آزمایشی (برای QA/پشتیبانی) */
export class PromotionPreviewDto {
  @IsInt()
  @Type(() => Number)
  promotionId: number;

  /**
   * اقلام سبد آزمایشی؛ قیمت‌ها از دیتابیس خوانده می‌شوند
   */
  @IsOptional()
  @IsArray()
  items?: { variantId: number; quantity: number }[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  productIds?: number[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  quantity?: number;

  @IsOptional()
  @IsDateString()
  now?: string;

  @IsOptional()
  @IsBoolean()
  allowStacking?: boolean;

  @IsOptional()
  @IsString()
  guestId?: string;
}
