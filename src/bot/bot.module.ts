import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from 'src/order/entities/order.entity';
import { Payment } from 'src/payment/entities/payment.entity';
import { Variant } from 'src/products/entities/variant.entity';
import { User } from 'src/users/entities/user.entity';
import { WalletTransaction } from 'src/wallet/entities/wallet-transaction.entity';

import { BotController } from './bot.controller';
import { BotAuthGuard } from './guards/bot-auth.guard';
import { BotAuthService } from './services/bot-auth.service';
import { BotCustomersService } from './services/bot-customers.service';
import { BotInventoryService } from './services/bot-inventory.service';
import { BotOrdersService } from './services/bot-orders.service';
import { BotSalesService } from './services/bot-sales.service';

/**
 * API فقط‌خواندنی ربات تلگرام.
 *
 * این ماژول هیچ controller غیر GET ندارد و هیچ entity را serialize نمی‌کند.
 * احراز هویت آن کاملاً از JWT/کوکی پنل مدیر جدا است.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      Payment,
      Variant,
      User,
      WalletTransaction,
    ]),
  ],
  controllers: [BotController],
  providers: [
    BotAuthService,
    BotAuthGuard,
    BotSalesService,
    BotOrdersService,
    BotInventoryService,
    BotCustomersService,
  ],
})
export class BotModule {}
