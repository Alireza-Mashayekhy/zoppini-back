import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerGuard } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CartsModule } from './cart/cart.module';
import { CategoriesModule } from './categories/categories.module';
import { TypeOrmConfigService } from './common/config/typeorm.config';
import { FilesModule } from './files/files.module';
import { OrdersModule } from './order/order.module';
import { OtpModule } from './otp/otp.module';
import { ProductsModule } from './products/products.module';
import { RedisModule } from './redis/redis.module';
import { UsersModule } from './users/users.module';
import { ClubModule } from './club/club.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    TypeOrmModule.forRootAsync({
      useClass: TypeOrmConfigService,
    }),
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
    ProductsModule,
    CartsModule,
    OrdersModule,
    ClubModule,
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
