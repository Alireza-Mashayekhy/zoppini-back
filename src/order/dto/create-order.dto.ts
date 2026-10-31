import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

export enum ShippingMethod {
  POST = 'post',
  COURIER = 'courier',
  TIBAX = 'tibax',
  PICKUP = 'pickup',
}

export class CreateOrderDto {
  @ValidateIf(
    o =>
      o.shippingMethod !== ShippingMethod.PICKUP || o.addressId !== undefined,
  )
  @IsInt()
  @Min(1)
  addressId?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  discountCode?: string;

  @IsEnum(ShippingMethod)
  shippingMethod: ShippingMethod;

  @IsOptional()
  @IsBoolean()
  useWallet?: boolean;
}
