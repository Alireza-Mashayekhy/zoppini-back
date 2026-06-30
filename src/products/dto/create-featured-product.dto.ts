import { IsNumber, IsOptional, Min } from 'class-validator';

export class CreateFeaturedProductDto {
  @IsNumber()
  productId: number;

  @IsNumber()
  colorId: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  order?: number;
}

export class UpdateFeaturedProductDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  order?: number;
}
