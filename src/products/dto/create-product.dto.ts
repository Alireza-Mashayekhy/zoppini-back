import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

class CreateVariantDto {
  @ApiProperty()
  @IsNumber()
  @IsNotEmpty()
  colorId: number;

  @ApiProperty()
  @IsNumber()
  @IsNotEmpty()
  sizeId: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @IsOptional()
  stock?: number;

  @ApiProperty()
  @IsString()
  @IsOptional()
  sku?: string;
}

export class CreateProductDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  productCode: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  slug: string;

  @ApiProperty()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty()
  @IsString()
  @IsOptional()
  careInstructionsHtml?: string;

  // تبدیل رشته JSON به آرایه اعداد
  @ApiProperty({ type: [Number] })
  @Transform(({ value }) => {
    return typeof value === 'string' ? JSON.parse(value) : value;
  })
  @IsArray()
  @IsNumber({}, { each: true })
  @IsNotEmpty()
  categoryIds: number[];

  // تبدیل رشته JSON به آرایه اشیاء CreateVariantDto
  @ApiProperty({ type: [CreateVariantDto] })
  @Transform(({ value }) => {
    return typeof value === 'string' ? JSON.parse(value) : value;
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants: CreateVariantDto[];
}

export class UploadColorImageDto {
  @ApiProperty()
  @IsNumber()
  colorId: number;
}

export class AddColorDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  hexCode: string;
}

export class AddSizeDto {
  @ApiProperty()
  @IsString()
  name: string;
}
