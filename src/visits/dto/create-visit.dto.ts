import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * صفحات شناخته‌شده برای ثبت بازدید.
 * مقدار page توسط این لیست محدود می‌شود تا از درج رکوردهای دلخواه جلوگیری شود.
 */
export const TRACKABLE_PAGES = ['landing-opening', 'gamification'] as const;

export type TrackablePage = (typeof TRACKABLE_PAGES)[number];

export class CreateVisitDto {
  @IsIn(TRACKABLE_PAGES)
  page: TrackablePage;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  referrer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  userAgent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  deviceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  os?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  browser?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  screen?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  utmSource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  utmMedium?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  utmCampaign?: string;
}
