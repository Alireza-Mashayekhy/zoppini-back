import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CategoriesModule } from 'src/categories/categories.module';
import { FilesModule } from 'src/files/files.module';

import { Comment } from './entities/comment.entity';
import { Product } from './entities/product.entity';
import { Color } from './entities/product-color.entity';
import { ProductColorImage } from './entities/product-color-image.entity';
import { Size } from './entities/product-size.entity';
import { Variant } from './entities/variant.entity';
import { AdmiProductsController } from './products.admin.controller';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Product,
      Variant,
      Comment,
      Color,
      Size,
      ProductColorImage,
    ]),
    CategoriesModule,
    FilesModule,
  ],
  controllers: [ProductsController, AdmiProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
