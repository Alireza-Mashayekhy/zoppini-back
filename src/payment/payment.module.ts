import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersModule } from 'src/order/order.module';

import { Payment } from './entities/payment.entity';
import { PaymentController } from './payment.controller';
import { DigipayAuthService } from './services/digipay-auth.service';
import { DigipayPaymentService } from './services/digipay-payment.service';
import { MellatPaymentService } from './services/mellat-payment.service';
import { TaraAuthService } from './services/tara-auth.service';
import { TaraPaymentService } from './services/tara-payment.service';
import { ZarinpalAuthService } from './services/zarinpal-auth.service';
import { ZarinpalPaymentService } from './services/zarinpal-payment.service';

@Module({
  imports: [TypeOrmModule.forFeature([Payment]), HttpModule, OrdersModule],
  controllers: [PaymentController],
  providers: [
    MellatPaymentService,
    ZarinpalPaymentService,
    ZarinpalAuthService,
    ZarinpalPaymentService,
    DigipayAuthService,
    DigipayPaymentService,
    TaraPaymentService,
    TaraAuthService,
  ],
  exports: [
    MellatPaymentService,
    ZarinpalPaymentService,
    DigipayPaymentService,
    TaraPaymentService,
  ],
})
export class PaymentModule {}
