// src/rahkaran/rahkaran.module.ts
import { HttpModule } from '@nestjs/axios';
import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotReportsModule } from 'src/bot-reports/bot-reports.module';
import { Product } from 'src/products/entities/product.entity';
import { Variant } from 'src/products/entities/variant.entity';

// ✅ مسیر درست به OrdersModule
import { OrdersModule } from '../order/order.module';
import { Color } from '../products/entities/product-color.entity';
import { Size } from '../products/entities/product-size.entity';
import { ProductsModule } from '../products/products.module';
import { UsersModule } from '../users/users.module';
import { RahkaranInvoiceSync } from './entities/rahkaran-invoice-sync.entity';
import { RahkaranController } from './rahkaran.controller';
import { RahkaranService } from './rahkaran.service';
import { RahkaranInvoiceSyncScheduler } from './rahkaran-invoice-sync.scheduler';
import { RahkaranInvoiceSyncService } from './rahkaran-invoice-sync.service';
import { RahkaranProductSyncService } from './rahkaran-product-sync.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      Color,
      Size,
      Product,
      Variant,
      RahkaranInvoiceSync,
    ]),
    HttpModule.register({
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    }),
    forwardRef(() => UsersModule),
    forwardRef(() => ProductsModule),
    forwardRef(() => OrdersModule),
    BotReportsModule,
  ],
  providers: [
    RahkaranService,
    RahkaranProductSyncService,
    RahkaranInvoiceSyncService,
    RahkaranInvoiceSyncScheduler,
  ],
  controllers: [RahkaranController],
  exports: [
    RahkaranService,
    RahkaranProductSyncService,
    RahkaranInvoiceSyncService,
  ],
})
export class RahkaranModule {}
