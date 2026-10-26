import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Address } from 'src/address/entities/address.entity';
import { Order } from 'src/order/entities/order.entity';
import { OrderItem } from 'src/order/entities/order-item';
import { Payment } from 'src/payment/entities/payment.entity';
import { Product } from 'src/products/entities/product.entity';
import { Color } from 'src/products/entities/product-color.entity';
import { Size } from 'src/products/entities/product-size.entity';
import { Variant } from 'src/products/entities/variant.entity';
import { User } from 'src/users/entities/user.entity';
import { WalletTransaction } from 'src/wallet/entities/wallet-transaction.entity';

import { BotAccessService } from './bot-access.service';
import { BotEventsScheduler } from './bot-events.scheduler';
import { BotEventsService } from './bot-events.service';
import { BOT_REPORTS_READER } from './bot-reports.contract';
import { BotReportsController } from './bot-reports.controller';
import { BotReportsService } from './bot-reports.service';
import { BotRoleGuard } from './bot-role.guard';
import { BotServiceKeyGuard } from './bot-service-key.guard';
import { BotSettingsService } from './bot-settings.service';
import { BotInventoryAlertState } from './entities/bot-inventory-alert-state.entity';
import { BotOperator } from './entities/bot-operator.entity';
import { BotOutboxEvent } from './entities/bot-outbox-event.entity';
import { BotSetting } from './entities/bot-setting.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      Payment,
      WalletTransaction,
      Variant,
      Product,
      Color,
      Size,
      User,
      Address,
      BotSetting,
      BotOperator,
      BotOutboxEvent,
      BotInventoryAlertState,
    ]),
  ],
  controllers: [BotReportsController],
  providers: [
    BotServiceKeyGuard,
    BotRoleGuard,
    BotAccessService,
    BotSettingsService,
    BotEventsService,
    BotEventsScheduler,
    BotReportsService,
    { provide: BOT_REPORTS_READER, useExisting: BotReportsService },
  ],
  exports: [BotEventsService, BotSettingsService, BotAccessService],
})
export class BotReportsModule {}
