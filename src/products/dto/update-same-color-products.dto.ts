import { IsArray, IsNumber } from 'class-validator';

export class UpdateSameColorProductsDto {
  @IsArray()
  @IsNumber({}, { each: true })
  productIds: number[];
}
