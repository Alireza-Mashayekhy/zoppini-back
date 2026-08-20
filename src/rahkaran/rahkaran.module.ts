// src/rahkaran/rahkaran.module.ts
import { HttpModule } from '@nestjs/axios';
import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from 'src/products/entities/product.entity';
import { Variant } from 'src/products/entities/variant.entity';

// ✅ مسیر درست به OrdersModule
import { OrdersModule } from '../order/order.module';
import { Color } from '../products/entities/product-color.entity';
import { Size } from '../products/entities/product-size.entity';
import { ProductsModule } from '../products/products.module';
import { UsersModule } from '../users/users.module';
import { RahkaranController } from './rahkaran.controller';
import { RahkaranService } from './rahkaran.service';
import { RahkaranProductSyncService } from './rahkaran-product-sync.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Color, Size, Product, Variant]),
    HttpModule.register({
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    }),
    forwardRef(() => UsersModule),
    forwardRef(() => ProductsModule),
    forwardRef(() => OrdersModule),
  ],
  providers: [RahkaranService, RahkaranProductSyncService],
  controllers: [RahkaranController],
  exports: [RahkaranService, RahkaranProductSyncService],
})
export class RahkaranModule {}
