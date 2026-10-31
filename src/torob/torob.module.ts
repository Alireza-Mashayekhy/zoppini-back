import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from 'src/categories/entities/category.entity';
import { DiscountsModule } from 'src/discounts/discounts.module';
import { Order } from 'src/order/entities/order.entity';
import { Product } from 'src/products/entities/product.entity';
import { ProductColorImage } from 'src/products/entities/product-color-image.entity';
import { Variant } from 'src/products/entities/variant.entity';

import { TorobOrderTrackingController } from './torob-order-tracking.controller';
import { TorobOrderTrackingService } from './torob-order-tracking.service';
import { TorobOrderGuard } from './torob-order.guard';
import { TorobController } from './torob.controller';
import { TorobService } from './torob.service';
import { TorobTokenGuard } from './torob-token.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Product,
      Variant,
      ProductColorImage,
      Category,
      Order,
    ]),
    DiscountsModule,
  ],
  controllers: [TorobController, TorobOrderTrackingController],
  providers: [
    TorobService,
    TorobTokenGuard,
    TorobOrderTrackingService,
    TorobOrderGuard,
  ],
})
export class TorobModule {}
