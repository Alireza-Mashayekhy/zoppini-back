import { BadRequestException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Response } from 'express';
import { CartsService } from 'src/cart/cart.service';
import { ClubService } from 'src/club/club.service';
import { OtpService } from 'src/otp/otp.service';
import { CreateUserDto } from 'src/users/dto/create-user.dto';
import { User } from 'src/users/entities/user.entity';
import { UsersService } from 'src/users/users.service';

import { LoginWithPasswordDto } from './dto/login-with-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { SendVerifyOtp } from './dto/verify-otp.dto';

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly otpService: OtpService,
    private readonly cartsService: CartsService,
    private readonly clubService: ClubService,
  ) {}

  async sendCode(sendOtpDto: SendOtpDto) {
    const user = await this.usersService.findWithPhone(sendOtpDto.phone);

    const response = await this.otpService.sendOtp(sendOtpDto.phone);

    const { message, ...payload } = response;

    return {
      message,
      data: {
        ...payload,
        newUser: !user,
      },
    };
  }

  async login(
    sendVerifyOtp: SendVerifyOtp,
    guestId: string | undefined,
    response: Response,
  ) {
    await this.otpService.verifyOtp(sendVerifyOtp.phone, sendVerifyOtp.code);

    const user = await this.usersService.findWithPhone(sendVerifyOtp.phone);

    if (!user) {
      throw new BadRequestException('کاربری با این شماره تلفن یافت نشد');
    }

    // ادغام سبد خرید مهمان
    if (guestId) {
      await this.cartsService.mergeGuestCart(user.id, guestId);
      response.clearCookie('guestId', { path: '/' });
    }

    const accessToken = await this.generateAccessToken(user);
    const refreshToken = await this.generateRefreshToken(user);

    response.cookie('access_token', accessToken, this.accessCookieOptions);
    response.cookie('refresh_token', refreshToken, this.refreshCookieOptions);

    return {
      message: 'login successfully',
    };
  }

  async signUp(
    createUserDto: CreateUserDto,
    guestId: string | undefined,
    response: Response,
  ) {
    await this.otpService.verifyOtp(createUserDto.phone, createUserDto.code);

    const user = await this.usersService.findWithPhone(createUserDto.phone);
    const userEmail = await this.usersService.findWithEmail(
      createUserDto.email,
    );

    if (userEmail) {
      throw new BadRequestException('کاربر با این ایمیل وجود دارد');
    }
    if (user) {
      throw new BadRequestException('کاربر با این شماره تلفن وجود دارد');
    }

    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);

    const newUser = await this.usersService.create({
      ...createUserDto,
      password: hashedPassword,
    });

    const [firstName, ...lastNameParts] = createUserDto.fullName
      .trim()
      .split(' ');
    const lastName = lastNameParts.join(' ') || '';

    // ثبت غیرهمزمان (اجرا در پس‌زمینه) برای عدم تأخیر در پاسخ
    this.clubService
      .registerCustomer({
        firstName: firstName,
        lastName: lastName,
        customerCode: createUserDto.phone,
        email: createUserDto.email,
        birthDate: createUserDto.birthDate || undefined,
      })
      .catch(err => {
        return err;
      });

    // ادغام سبد خرید مهمان
    if (guestId) {
      await this.cartsService.mergeGuestCart(newUser.id, guestId);
      response.clearCookie('guestId', { path: '/' });
    }

    const accessToken = await this.generateAccessToken(newUser);
    const refreshToken = await this.generateRefreshToken(newUser);

    response.cookie('access_token', accessToken, this.accessCookieOptions);
    response.cookie('refresh_token', refreshToken, this.refreshCookieOptions);

    return {
      message: 'sign up successfully',
    };
  }

  async loginWithPassword(
    dto: LoginWithPasswordDto,
    guestId: string | undefined,
    response: Response,
  ) {
    const user = await this.usersService.findWithPhone(dto.phone);

    if (!user) {
      throw new BadRequestException('شماره تلفن یا رمز عبور اشتباه است');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);

    if (!isMatch) {
      throw new BadRequestException('شماره تلفن یا رمز عبور اشتباه است');
    }

    // ادغام سبد خرید مهمان
    if (guestId) {
      await this.cartsService.mergeGuestCart(user.id, guestId);
      response.clearCookie('guestId', { path: '/' });
    }

    const accessToken = await this.generateAccessToken(user);
    const refreshToken = await this.generateRefreshToken(user);

    response.cookie('access_token', accessToken, this.accessCookieOptions);
    response.cookie('refresh_token', refreshToken, this.refreshCookieOptions);

    return {
      message: 'login successfully',
    };
  }

  async refresh(refreshToken: string, response: Response) {
    const payload = await this.jwtService.verifyAsync(refreshToken, {
      secret: process.env.JWT_REFRESH_SECRET,
    });

    const user = await this.usersService.findOne(payload.sub);

    if (!user) {
      throw new BadRequestException('user not found');
    }

    const newAccessToken = await this.generateAccessToken(user);

    const newRefreshToken = await this.generateRefreshToken(user);

    response.cookie('access_token', newAccessToken, this.accessCookieOptions);

    response.cookie(
      'refresh_token',
      newRefreshToken,
      this.refreshCookieOptions,
    );

    return {
      message: 'token refreshed',
    };
  }

  logout(response: Response) {
    response.clearCookie('access_token');

    response.clearCookie('refresh_token');

    return {
      message: 'logout success',
    };
  }

  async forgotPassword(dto: SendOtpDto) {
    const user = await this.usersService.findWithPhone(dto.phone);

    if (!user) {
      throw new BadRequestException('کاربری با این شماره تلفن یافت نشد.');
    }

    return this.otpService.sendOtp(dto.phone);
  }

  async resetPassword(dto: ResetPasswordDto) {
    await this.otpService.verifyOtp(dto.phone, dto.code);

    const user = await this.usersService.findWithPhone(dto.phone);

    if (!user) {
      throw new BadRequestException('کاربری با این شماره تلفن یافت نشد.');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);

    await this.usersService.update(
      user.id,
      {
        password: hashedPassword,
      },
      user,
    );

    return {
      message: 'password changed successfully',
    };
  }

  private readonly accessCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 15 * 60 * 1000,
  };

  private readonly refreshCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };

  private async generateAccessToken(user: User) {
    // eslint-disable-next-line unused-imports/no-unused-vars
    const { password, ...payload } = user;

    return this.jwtService.signAsync(payload, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: '6h',
    });
  }

  private async generateRefreshToken(user: any) {
    return this.jwtService.signAsync(
      {
        sub: user.id,
      },
      {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: '30d',
      },
    );
  }
}
