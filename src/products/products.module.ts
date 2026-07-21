import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CategoriesModule } from 'src/categories/categories.module';
import { FilesModule } from 'src/files/files.module';
import { RahkaranModule } from 'src/rahkaran/rahkaran.module';

import { Comment } from './entities/comment.entity';
import { FeaturedProduct } from './entities/featured-product.entity';
import { Product } from './entities/product.entity';
import { Color } from './entities/product-color.entity';
import { ProductColorImage } from './entities/product-color-image.entity';
import { Size } from './entities/product-size.entity';
import { StyleProduct } from './entities/style-product.entity';
import { Variant } from './entities/variant.entity';
import { AdminFeaturedController } from './featured.admin.controller';
import { FeaturedController } from './featured.controller';
import { FeaturedService } from './featured.service';
import { AdmiProductsController } from './products.admin.controller';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { AdminStyleController } from './style.admin.controller';
import { StyleController } from './style.controller';
import { StyleService } from './style.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Product,
      Variant,
      Comment,
      Color,
      Size,
      ProductColorImage,
      FeaturedProduct,
      StyleProduct,
    ]),
    forwardRef(() => CategoriesModule),
    FilesModule,
    forwardRef(() => RahkaranModule),
  ],
  controllers: [
    ProductsController,
    AdmiProductsController,
    FeaturedController,
    AdminFeaturedController,
    StyleController,
    AdminStyleController,
  ],
  providers: [ProductsService, FeaturedService, StyleService],
  exports: [ProductsService],
})
export class ProductsModule {}
