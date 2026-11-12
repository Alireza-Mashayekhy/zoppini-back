import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from 'src/order/entities/order.entity';
import { User } from 'src/users/entities/user.entity';

import { AdminFirstPurchaseGiftController } from './admin-first-purchase-gift.controller';
import { FirstPurchaseGiftClaim } from './entities/first-purchase-gift-claim.entity';
import { FirstPurchaseGiftSettings } from './entities/first-purchase-gift-settings.entity';
import { FirstPurchaseGiftController } from './first-purchase-gift.controller';
import { FirstPurchaseGiftService } from './first-purchase-gift.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      FirstPurchaseGiftSettings,
      FirstPurchaseGiftClaim,
      Order,
      User,
    ]),
  ],
  controllers: [FirstPurchaseGiftController, AdminFirstPurchaseGiftController],
  providers: [FirstPurchaseGiftService],
  exports: [FirstPurchaseGiftService],
})
export class FirstPurchaseGiftModule {}
