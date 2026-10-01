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

import { DiscountKind, DiscountType } from '../entities/discount.entity';

export class CreateDiscountDto {
  @IsOptional()
  @IsEnum(DiscountKind)
  kind?: DiscountKind;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  code?: string;

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

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUsesPerUser?: number | null;

  /**
   * (فقط کد تخفیف) سقف کل دفعات استفاده؛ null = نامحدود
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  maxTotalUses?: number | null;

  /**
   * (فقط کد تخفیف) عدم اعمال روی کالاهای در فروش ویژه
   */
  @IsOptional()
  @IsBoolean()
  excludeSaleItems?: boolean;

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

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  excludedProductIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  excludedCategoryIds?: number[];
}
