import { IsNumber, Max, Min } from 'class-validator';

export class UpdateCartItemDto {
  @IsNumber()
  @Min(1)
  @Max(99)
  quantity: number;
}
