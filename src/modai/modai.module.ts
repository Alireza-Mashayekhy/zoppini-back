import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscountsModule } from 'src/discounts/discounts.module';
import { ProductGuidesModule } from 'src/product-guides/product-guides.module';
import { Product } from 'src/products/entities/product.entity';

import { ModaiController } from './modai.controller';
import { ModaiService } from './modai.service';
import { ModaiTokenGuard } from './modai-token.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product]),
    DiscountsModule,
    ProductGuidesModule,
  ],
  controllers: [ModaiController],
  providers: [ModaiService, ModaiTokenGuard],
})
export class ModaiModule {}
