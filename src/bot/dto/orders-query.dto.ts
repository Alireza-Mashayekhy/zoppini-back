import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { BOT_DEFAULT_PAGE_SIZE, BOT_MAX_PAGE_SIZE } from '../bot.constants';

export class OrdersQueryDto {
  @ApiProperty({
    example: 'ORD-12345678',
    description: 'شماره‌ی سفارش یا بخشی از آن (حداقل ۴ کاراکتر)',
  })
  @IsString()
  @MinLength(4)
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9-]+$/, {
    message: 'orderNumber may contain only letters, digits and dashes',
  })
  orderNumber: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 10, maximum: BOT_MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BOT_MAX_PAGE_SIZE)
  limit: number = 10;
}

export class InventoryQueryDto {
  @ApiProperty({
    example: 'کت',
    description: 'بخشی از نام محصول یا SKU (حداقل ۲ کاراکتر)',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  query: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    default: BOT_DEFAULT_PAGE_SIZE,
    maximum: BOT_MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BOT_MAX_PAGE_SIZE)
  limit: number = BOT_DEFAULT_PAGE_SIZE;
}

export class LowStockQueryDto {
  @ApiPropertyOptional({
    default: 3,
    description: 'واریانت‌هایی که موجودی قابل‌فروش آن‌ها ≤ این عدد است',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  threshold?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    default: BOT_DEFAULT_PAGE_SIZE,
    maximum: BOT_MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BOT_MAX_PAGE_SIZE)
  limit: number = BOT_DEFAULT_PAGE_SIZE;
}
