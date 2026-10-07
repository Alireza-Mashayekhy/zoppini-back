import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

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

export class CreatePageSeoDto {
  @ApiProperty({ example: '/about-us' })
  @Transform(({ value }) => normalizeSeoPath(value))
  @IsString()
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
}
