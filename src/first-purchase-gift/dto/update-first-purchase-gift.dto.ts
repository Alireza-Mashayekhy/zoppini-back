import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateFirstPurchaseGiftDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @IsOptional()
  @IsDateString()
  endsAt?: string | null;

  @IsOptional()
  @IsBoolean()
  popupEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  announcementEnabled?: boolean;

  @IsOptional()
  @IsIn(['session', 'daily', 'always'])
  popupFrequency?: 'session' | 'daily' | 'always';

  @IsOptional()
  @IsBoolean()
  stackWithDiscountCodes?: boolean;

  @IsOptional()
  @IsBoolean()
  stackWithSalePrices?: boolean;
}
