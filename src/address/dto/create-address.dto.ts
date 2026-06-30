// src/addresses/dto/create-address.dto.ts
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateAddressDto {
  @IsNumber()
  @Min(1)
  provinceId: number;

  @IsNumber()
  @Min(1)
  cityId: number;

  @IsString()
  address: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
