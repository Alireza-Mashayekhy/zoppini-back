import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CartsModule } from 'src/cart/cart.module';
import { ClubModule } from 'src/club/club.module';
import { jwtConstants } from 'src/common/constants/constants';
import { OtpModule } from 'src/otp/otp.module';
import { RahkaranModule } from 'src/rahkaran/rahkaran.module';
import { SmsModule } from 'src/sms/sms.module';
import { UsersModule } from 'src/users/users.module';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    UsersModule,
    OtpModule,
    CartsModule,
    ClubModule,
    SmsModule,
    RahkaranModule,
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
