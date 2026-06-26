import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  shippingAddress: string;

  @IsString()
  phone: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  shippingCost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discount?: number;
}
