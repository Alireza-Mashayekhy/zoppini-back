import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * بازه‌ی تاریخ به تقویم میلادی و به شکل YYYY-MM-DD.
 * مرز روزها در API با Asia/Tehran محاسبه می‌شود.
 */
export class RangeQueryDto {
  @ApiProperty({ example: '2026-10-01', description: 'تاریخ شروع (شامل)' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from must be in YYYY-MM-DD format',
  })
  from: string;

  @ApiProperty({ example: '2026-10-20', description: 'تاریخ پایان (شامل)' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to must be in YYYY-MM-DD format',
  })
  to: string;
}
