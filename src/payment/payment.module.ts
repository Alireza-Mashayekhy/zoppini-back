import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersModule } from 'src/order/order.module';

import { Payment } from './entities/payment.entity';
import { PaymentController } from './payment.controller';
import { PaymentScheduler } from './payment.scheduler';
import { DigipayAuthService } from './services/digipay-auth.service';
import { DigipayPaymentService } from './services/digipay-payment.service';
import { MellatPaymentService } from './services/mellat-payment.service';
import { PaymentGuardService } from './services/payment-guard.service';
import { TaraAuthService } from './services/tara-auth.service';
import { TaraPaymentService } from './services/tara-payment.service';
import { ZarinpalPaymentService } from './services/zarinpal-payment.service';

@Module({
  imports: [TypeOrmModule.forFeature([Payment]), HttpModule, OrdersModule],
  controllers: [PaymentController],
  providers: [
    PaymentGuardService,
    MellatPaymentService,
    ZarinpalPaymentService,
    DigipayAuthService,
    DigipayPaymentService,
    TaraPaymentService,
    TaraAuthService,
    PaymentScheduler,
  ],
  exports: [
    MellatPaymentService,
    ZarinpalPaymentService,
    DigipayPaymentService,
    TaraPaymentService,
  ],
})
export class PaymentModule {}
