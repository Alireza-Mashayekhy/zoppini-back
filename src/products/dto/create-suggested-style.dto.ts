import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateSuggestedProductDto {
  @IsNumber()
  productId: number;

  @IsNumber()
  colorId: number;

  @IsString()
  faTitle: string;

  @IsString()
  enTitle: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  order?: number;
}
