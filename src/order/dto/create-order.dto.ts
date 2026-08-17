import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
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
  @IsString()
  discountCode?: string;

  @IsEnum(ShippingMethod)
  shippingMethod: ShippingMethod;
}
