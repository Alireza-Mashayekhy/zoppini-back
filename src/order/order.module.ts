// src/orders/orders.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Cart } from 'src/cart/entities/cart.entity';

import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item';
import { AdminOrdersController } from './order.admin.controller';
import { OrdersController } from './order.controller';
import { OrdersService } from './order.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order, OrderItem, Cart])],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
