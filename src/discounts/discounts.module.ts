import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Cart } from 'src/cart/entities/cart.entity';
import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import { User } from 'src/users/entities/user.entity';

import { AdminDiscountController } from './admin.discount.controller';
import { DiscountController } from './discount.controller';
import { DiscountService } from './discounts.service';
import { Discount } from './entities/discount.entity';
import { DiscountUsage } from './entities/discount-code-usage.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Discount,
      DiscountUsage,
      User,
      Product,
      Category,
      Cart,
    ]),
  ],

  controllers: [AdminDiscountController, DiscountController],

  providers: [DiscountService],

  exports: [DiscountService],
})
export class DiscountsModule {}
