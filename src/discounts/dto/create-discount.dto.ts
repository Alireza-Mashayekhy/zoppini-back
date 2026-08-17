import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

import { DiscountType } from '../entities/discount.entity';

export class CreateDiscountDto {
  @IsString()
  code: string;

  @IsEnum(DiscountType)
  type: DiscountType;

  @IsNumber()
  @Min(0)
  value: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxDiscountAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderAmount?: number;

  @IsDateString()
  startsAt: string;

  @IsDateString()
  expiresAt: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * خالی => همه کاربران
   */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  userIds?: number[];

  /**
   * خالی => همه محصولات
   */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  productIds?: number[];

  /**
   * خالی => همه دسته‌ها
   */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  categoryIds?: number[];
}
