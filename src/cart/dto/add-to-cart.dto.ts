import { IsNumber, Max, Min } from 'class-validator';

export class AddToCartDto {
  @IsNumber()
  variantId: number;

  @IsNumber()
  @Min(1)
  @Max(99)
  quantity: number;
}
