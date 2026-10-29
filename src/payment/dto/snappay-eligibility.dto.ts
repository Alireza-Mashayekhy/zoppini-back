import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * بررسی امکان پرداخت اسنپ‌پی (eligible).
 *
 * یکی از دو ورودی کافی است:
 * - `orderId`: مبلغ دقیقاً سمت سرور از همان سفارش محاسبه می‌شود
 *   (صفحهٔ انتخاب درگاه برای سفارش ساخته‌شده).
 * - `amount`: مبلغ به ریال، فقط برای نمایش پیش از ساخت سفارش در چک‌اوت.
 *   مبلغ نهایی هنگام شروع پرداخت دوباره سمت سرور از روی سفارش محاسبه و
 *   eligibility برای همان مبلغ واقعی تکرار می‌شود؛ پس دست‌کاری این
 *   پارامتر اثری بر مبلغ تراکنش ندارد.
 */
export class SnappayEligibilityDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orderId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount?: number;
}
