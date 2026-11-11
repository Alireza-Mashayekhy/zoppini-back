import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Cart } from 'src/cart/entities/cart.entity';
import { CartItem } from 'src/cart/entities/cart-item.entity';
import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import { ProductsModule } from 'src/products/products.module';

import { AdminPromotionsController } from './admin/admin-promotions.controller';
import { Promotion } from './entities/promotion.entity';
import {
  PromotionEvent,
  PromotionRedemption,
} from './entities/promotion-redemption.entity';
import { PromotionsController } from './promotions.controller';
import { PromotionsRepository } from './promotions.repository';
import { PromotionsService } from './promotions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Promotion,
      PromotionRedemption,
      PromotionEvent,
      Cart,
      CartItem,
      Product,
      Category,
    ]),
    forwardRef(() => ProductsModule),
  ],
  controllers: [AdminPromotionsController, PromotionsController],
  providers: [PromotionsService, PromotionsRepository],
  exports: [PromotionsService, PromotionsRepository],
})
export class PromotionsModule {}
