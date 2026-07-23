import { IsEnum, IsNotEmpty, IsNumber } from 'class-validator';

import { PaymentGateway } from '../entities/payment.entity';

export class RequestPaymentDto {
  @IsNotEmpty()
  @IsNumber()
  orderId: number;

  @IsNotEmpty()
  @IsEnum(PaymentGateway)
  gateway: PaymentGateway;
}
