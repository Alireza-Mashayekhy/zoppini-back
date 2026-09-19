import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersModule } from 'src/order/order.module';
import { WalletCharge } from 'src/wallet/entities/wallet-charge.entity';
import { WalletModule } from 'src/wallet/wallet.module';

import { Payment } from './entities/payment.entity';
import { PaymentController } from './payment.controller';
import { PaymentScheduler } from './payment.scheduler';
import { DigipayAuthService } from './services/digipay-auth.service';
import { DigipayPaymentService } from './services/digipay-payment.service';
import { MellatPaymentService } from './services/mellat-payment.service';
import { PaymentGuardService } from './services/payment-guard.service';
import { TaraAuthService } from './services/tara-auth.service';
import { TaraPaymentService } from './services/tara-payment.service';
import { WalletChargeService } from './services/wallet-charge.service';
import { ZarinpalPaymentService } from './services/zarinpal-payment.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, WalletCharge]),
    HttpModule,
    OrdersModule,
    WalletModule,
  ],
  controllers: [PaymentController],
  providers: [
    PaymentGuardService,
    MellatPaymentService,
    ZarinpalPaymentService,
    DigipayAuthService,
    DigipayPaymentService,
    TaraPaymentService,
    TaraAuthService,
    WalletChargeService,
    PaymentScheduler,
  ],
  exports: [
    MellatPaymentService,
    ZarinpalPaymentService,
    DigipayPaymentService,
    TaraPaymentService,
    WalletChargeService,
  ],
})
export class PaymentModule {}
