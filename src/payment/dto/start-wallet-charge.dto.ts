import { IsEnum, IsNotEmpty, IsNumber, Min } from 'class-validator';

import { PaymentGateway } from '../entities/payment.entity';

export class StartWalletChargeDto {
  /** مبلغ شارژ به تومان (حداقل ۱۰۰ تومان = ۱۰٬۰۰۰ ریال) */
  @IsNotEmpty()
  @IsNumber()
  @Min(1000)
  amount: number;

  @IsNotEmpty()
  @IsEnum(PaymentGateway)
  gateway: PaymentGateway;
}
