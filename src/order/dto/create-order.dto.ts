import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export enum ShippingMethod {
  POST = 'post',
  COURIER = 'courier',
  TIBAX = 'tibax',
}

export class CreateOrderDto {
  @IsNumber()
  @IsNotEmpty()
  addressId: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discount?: number;

  @IsEnum(ShippingMethod)
  shippingMethod: ShippingMethod;
}
