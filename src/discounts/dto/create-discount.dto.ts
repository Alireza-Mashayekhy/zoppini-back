import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
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

  // =========================================================
  // تخفیف متوالی / مرحله‌ای (فقط فروش ویژه)
  // =========================================================

  /**
   * آیا این فروش ویژه به‌عنوان یک «مرحله» روی مبلغ باقی‌ماندهٔ تخفیف‌های
   * قبلی اعمال شود؟ پیش‌فرض false = رفتار قبلی (فقط بهترین تخفیف).
   */
  @IsOptional()
  @IsBoolean()
  stackable?: boolean;

  /**
   * ترتیب مرحله؛ عدد کوچک‌تر زودتر اعمال می‌شود (۰ تا ۱۰۰۰).
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  stackPriority?: number;

  /**
   * اعمال روی همهٔ محصولات (بدون انتخاب محصول/دسته).
   */
  @IsOptional()
  @IsBoolean()
  appliesToAllProducts?: boolean;
}
