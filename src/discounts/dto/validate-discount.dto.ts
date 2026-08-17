// src/discount/dto/validate-discount.dto.ts

import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class ValidateDiscountItemDto {
  @IsInt()
  productId: number;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsNumber()
  @Min(0)
  price: number;
}

export class ValidateDiscountDto {
  @IsString()
  code: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ValidateDiscountItemDto)
  items: ValidateDiscountItemDto[];
}
