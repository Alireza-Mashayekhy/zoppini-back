import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CartsModule } from 'src/cart/cart.module';
import { jwtConstants } from 'src/common/constants/constants';
import { OtpModule } from 'src/otp/otp.module';
import { UsersModule } from 'src/users/users.module';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    UsersModule,
    OtpModule,
    CartsModule,
    JwtModule.register({
      global: true,
      secret: jwtConstants.secret,
      signOptions: { expiresIn: `30d` },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
