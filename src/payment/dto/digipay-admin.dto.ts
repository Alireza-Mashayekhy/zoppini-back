import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * عودت وجه دیجی‌پی برگشت‌ناپذیر است و مبلغ را از حساب پذیرنده کم می‌کند؛
 * به همین دلیل (مثل مسیر اسنپ‌پی) فیلد `confirm` باید صراحتاً true باشد.
 */
export class DigipayAdminRefundDto {
  @IsBoolean()
  confirm: boolean;

  /**
   * مبلغ عودت به **تومان**. خالی بماند، کل ماندهٔ قابل عودت برمی‌گردد.
   * برای Partial Refund (عودت بخشی از خرید) از این فیلد استفاده کنید.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(1)
  amount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
