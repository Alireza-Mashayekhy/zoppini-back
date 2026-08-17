import { IsNotEmpty, IsString } from 'class-validator';

export class ApplyDiscountCodeDto {
  @IsString()
  @IsNotEmpty()
  code: string;
}
