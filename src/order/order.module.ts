// src/order/order.module.ts
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Address } from 'src/address/entities/address.entity';
import { Cart } from 'src/cart/entities/cart.entity';
import { DiscountsModule } from 'src/discounts/discounts.module';
import { Discount } from 'src/discounts/entities/discount.entity';
import { DiscountUsage } from 'src/discounts/entities/discount-code-usage.entity';
import { Variant } from 'src/products/entities/variant.entity';
import { RahkaranModule } from 'src/rahkaran/rahkaran.module';
import { SmsModule } from 'src/sms/sms.module';
import { User } from 'src/users/entities/user.entity';

import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item';
import { AdminOrdersController } from './order.admin.controller';
import { OrdersController } from './order.controller';
import { OrdersService } from './order.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      Variant,
      Cart,
      Address,
      User,
      Discount,
      DiscountUsage,
    ]),
    SmsModule,
    forwardRef(() => RahkaranModule),
    DiscountsModule,
  ],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
