import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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

  @ApiProperty({ type: [Number] })
  @IsArray()
  @IsNumber({}, { each: true })
  @IsNotEmpty()
  categoryIds: number[];

  @ApiProperty()
  @IsString()
  @IsOptional()
  careInstructionsHtml?: string;

  @ApiProperty()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants: CreateVariantDto[];
}

export class UploadColorImageDto {
  @ApiProperty()
  @IsNumber()
  colorId: number;

  @ApiProperty()
  @IsOptional()
  @IsString()
  altText?: string;
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
