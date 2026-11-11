import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsModule } from 'src/analytics/analytics.module';
import { OrdersModule } from 'src/order/order.module';
import { PromotionsModule } from 'src/promotions/promotions.module';
import { WalletCharge } from 'src/wallet/entities/wallet-charge.entity';
import { WalletModule } from 'src/wallet/wallet.module';

import { Payment } from './entities/payment.entity';
import { PaymentRefund } from './entities/payment-refund.entity';
import { PaymentController } from './payment.controller';
import { PaymentScheduler } from './payment.scheduler';
import { DigipayAuthService } from './services/digipay-auth.service';
import { DigipayPaymentService } from './services/digipay-payment.service';
import { MellatPaymentService } from './services/mellat-payment.service';
import { PaymentGuardService } from './services/payment-guard.service';
import { PromotionRevalidationService } from './services/promotion-revalidation.service';
import { SnappayPaymentService } from './services/snappay-payment.service';
import { TaraAuthService } from './services/tara-auth.service';
import { TaraPaymentService } from './services/tara-payment.service';
import { WalletChargeService } from './services/wallet-charge.service';
import { ZarinpalPaymentService } from './services/zarinpal-payment.service';

@Module({
  imports: [
    AnalyticsModule,
    TypeOrmModule.forFeature([Payment, PaymentRefund, WalletCharge]),
    HttpModule,
    OrdersModule,
    WalletModule,
    PromotionsModule,
  ],
  controllers: [PaymentController],
  providers: [
    PaymentGuardService,
    PromotionRevalidationService,
    MellatPaymentService,
    ZarinpalPaymentService,
    DigipayAuthService,
    DigipayPaymentService,
    TaraPaymentService,
    TaraAuthService,
    SnappayPaymentService,
    WalletChargeService,
    PaymentScheduler,
  ],
  exports: [
    PromotionRevalidationService,
    MellatPaymentService,
    ZarinpalPaymentService,
    DigipayPaymentService,
    TaraPaymentService,
    SnappayPaymentService,
    WalletChargeService,
  ],
})
export class PaymentModule {}
