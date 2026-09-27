import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from 'src/categories/entities/category.entity';
import { DiscountsModule } from 'src/discounts/discounts.module';
import { Product } from 'src/products/entities/product.entity';
import { ProductColorImage } from 'src/products/entities/product-color-image.entity';
import { Variant } from 'src/products/entities/variant.entity';

import { TorobController } from './torob.controller';
import { TorobService } from './torob.service';
import { TorobTokenGuard } from './torob-token.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, Variant, ProductColorImage, Category]),
    DiscountsModule,
  ],
  controllers: [TorobController],
  providers: [TorobService, TorobTokenGuard],
})
export class TorobModule {}
