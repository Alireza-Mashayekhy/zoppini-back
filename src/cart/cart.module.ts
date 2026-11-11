import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscountsModule } from 'src/discounts/discounts.module';
import { Variant } from 'src/products/entities/variant.entity';
import { PromotionsModule } from 'src/promotions/promotions.module';

import { CartsController } from './cart.controller';
import { CartsService } from './cart.service';
import { Cart } from './entities/cart.entity';
import { CartItem } from './entities/cart-item.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Cart, CartItem, Variant]),
    DiscountsModule,
    PromotionsModule,
  ],
  controllers: [CartsController],
  providers: [CartsService],
  exports: [CartsService],
})
export class CartsModule {}
