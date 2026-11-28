import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscountsModule } from 'src/discounts/discounts.module';
import { Variant } from 'src/products/entities/variant.entity';
import { PromotionsModule } from 'src/promotions/promotions.module';
import { RahkaranModule } from 'src/rahkaran/rahkaran.module';

import { CartsController } from './cart.controller';
import { CartsService } from './cart.service';
import { Cart } from './entities/cart.entity';
import { CartItem } from './entities/cart-item.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Cart, CartItem, Variant]),
    DiscountsModule,
    PromotionsModule,
    // بررسی لحظه‌ای موجودی از راهکاران هنگام افزودن به سبد
    forwardRef(() => RahkaranModule),
  ],
  controllers: [CartsController],
  providers: [CartsService],
  exports: [CartsService],
})
export class CartsModule {}
