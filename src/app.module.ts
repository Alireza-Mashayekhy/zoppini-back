import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerGuard } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AddressesModule } from './address/address.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { B2bRequestModule } from './b2b-request/b2b-request.module';
import { BlogModule } from './blog/blog.module';
import { CartsModule } from './cart/cart.module';
import { CategoriesModule } from './categories/categories.module';
import { ClubModule } from './club/club.module';
import { TypeOrmConfigService } from './common/config/typeorm.config';
import { ContactModule } from './contact/contact.module';
import { DiscountsModule } from './discounts/discounts.module';
import { FilesModule } from './files/files.module';
import { LocationsModule } from './locations/locations.module';
import { OrdersModule } from './order/order.module';
import { OtpModule } from './otp/otp.module';
import { PaymentModule } from './payment/payment.module';
import { ProductsModule } from './products/products.module';
import { RahkaranModule } from './rahkaran/rahkaran.module';
import { RedisModule } from './redis/redis.module';
import { SitemapModule } from './sitemap/sitemap.module';
import { SmsModule } from './sms/sms.module';
import { UsersModule } from './users/users.module';
import { WishlistModule } from './wishlist/wishlist.module';
import { CatalogModule } from './catalog/catalog.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    TypeOrmModule.forRootAsync({
      useClass: TypeOrmConfigService,
    }),
    ScheduleModule.forRoot(),
    // CacheModule.register({
    //   ttl: 5000,
    //   max: 10,
    // }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    FilesModule,
    UsersModule,
    AuthModule,
    RedisModule,
    OtpModule,
    CategoriesModule,
    BlogModule,
    ProductsModule,
    CartsModule,
    OrdersModule,
    ClubModule,
    WishlistModule,
    AddressesModule,
    LocationsModule,
    SmsModule,
    B2bRequestModule,
    SitemapModule,
    RahkaranModule,
    PaymentModule,
    DiscountsModule,
    ContactModule,
    CatalogModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
