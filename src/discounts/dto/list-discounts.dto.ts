import { IsEnum, IsOptional, IsString } from 'class-validator';

import { DiscountKind } from '../entities/discount.entity';

export class ListDiscountsQueryDto {
  @IsOptional()
  @IsEnum(DiscountKind)
  kind?: DiscountKind;

  @IsOptional()
  @IsString()
  search?: string;
}
