import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

/**
 * مسیر صفحه را یکدست می‌کند:
 * اسلش ابتدایی اضافه می‌شود و اسلش‌های انتهایی حذف می‌گردند.
 * مثال: `about-us/` → `/about-us`
 */
export function normalizeSeoPath(value: unknown) {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();

  if (!trimmed) return trimmed;

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;

  return withLeadingSlash.length > 1
    ? withLeadingSlash.replace(/\/+$/, '')
    : withLeadingSlash;
}

/**
 * مقصد ریدایرکت را یکدست می‌کند:
 * فضای خالی حذف می‌شود و مقدار خالی به `null` (بدون ریدایرکت) تبدیل می‌شود.
 * مقدار نهایی یا مسیر نسبی (`/products`) است یا آدرس کامل `http(s)://…`.
 */
export function normalizeSeoTarget(value: unknown) {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();

  return trimmed || null;
}

/** بررسی می‌کند مقصد ریدایرکت، مسیر نسبی یا آدرس http(s) معتبر باشد */
export function isValidSeoTarget(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;

  if (value.startsWith('/')) {
    return !value.startsWith('//') && !value.includes('\\');
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** اعتبارسنج مقصد ریدایرکت (مسیر نسبی یا آدرس http(s)) */
export function IsSeoTarget(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isSeoTarget',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isValidSeoTarget(value);
        },
        defaultMessage() {
          return 'مقصد ریدایرکت باید مسیر نسبی (مثل /products) یا آدرس http(s) معتبر باشد';
        },
      },
    });
  };
}

export class CreatePageSeoDto {
  @ApiProperty({ example: '/about-us' })
  @Transform(({ value }) => normalizeSeoPath(value))
  @IsString()
  @Matches(/^\/(?!\/)/, {
    message: 'مسیر باید با یک / شروع شود و آدرس خارجی نباشد',
  })
  @Matches(/^[^\\]*$/, { message: 'مسیر نمی‌تواند شامل بک‌اسلش باشد' })
  path: string;

  @ApiProperty({ required: false, example: 'درباره ما' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  metaTitle?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  metaDescription?: string;

  @ApiProperty({
    required: false,
    default: true,
    description: 'false یعنی noindex؛ صفحه در نتایج جستجو نمی‌آید',
  })
  @IsOptional()
  @IsBoolean()
  indexable?: boolean;

  @ApiProperty({
    required: false,
    default: true,
    description: 'false یعنی nofollow؛ لینک‌های صفحه دنبال نمی‌شوند',
  })
  @IsOptional()
  @IsBoolean()
  followable?: boolean;

  @ApiProperty({
    required: false,
    example: '/products',
    description:
      'مقصد ریدایرکت 301 دائمی؛ مسیر نسبی (/products) یا آدرس کامل (https://…)',
  })
  @IsOptional()
  @Transform(({ value }) => normalizeSeoTarget(value))
  @IsSeoTarget()
  @MaxLength(2048)
  redirectTo?: string | null;

  @ApiProperty({
    required: false,
    default: false,
    description: 'اگر true باشد، URL در page-sitemap.xml منتشر می‌شود',
  })
  @IsOptional()
  @IsBoolean()
  includeInPageSitemap?: boolean;
}
