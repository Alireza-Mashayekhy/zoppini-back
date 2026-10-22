import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from 'src/order/entities/order.entity';
import { OrderItem } from 'src/order/entities/order-item';
import { Product } from 'src/products/entities/product.entity';
import { Color } from 'src/products/entities/product-color.entity';
import { Size } from 'src/products/entities/product-size.entity';
import { Variant } from 'src/products/entities/variant.entity';
import { User } from 'src/users/entities/user.entity';

import { BOT_REPORTS_READER } from './bot-reports.contract';
import { BotReportsController } from './bot-reports.controller';
import { BotReportsService } from './bot-reports.service';
import { BotServiceKeyGuard } from './bot-service-key.guard';

/**
 * ماژول API گزارش‌های ربات بله (`/api/bot/v1/...`).
 *
 * عمداً به `OrdersModule`/`ProductsModule` وابسته نیست و مستقیم از
 * ریپازیتوری‌ها می‌خواند تا هم گراف ماژول‌ها سبک بماند و هم خروجی ربات
 * کاملاً محدود به قرارداد باشد. فعال‌سازی نیازمند تنظیم
 * `ZOPPINI_BOT_SERVICE_TOKEN` روی بک‌اند است (بدون آن گارد 503 می‌دهد).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      Variant,
      Product,
      Color,
      Size,
      User,
    ]),
  ],
  controllers: [BotReportsController],
  providers: [
    BotServiceKeyGuard,
    BotReportsService,
    { provide: BOT_REPORTS_READER, useExisting: BotReportsService },
  ],
})
export class BotReportsModule {}
