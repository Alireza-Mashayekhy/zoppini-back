import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Response } from 'express';
import { CartsService } from 'src/cart/cart.service';
import { ClubService } from 'src/club/club.service';
import { OtpService } from 'src/otp/otp.service';
import { RahkaranService } from 'src/rahkaran/rahkaran.service';
import { SmsService } from 'src/sms/sms.service';
import { CreateUserDto } from 'src/users/dto/create-user.dto';
import { User } from 'src/users/entities/user.entity';
import { UsersService } from 'src/users/users.service';

import { LoginWithPasswordDto } from './dto/login-with-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { SendVerifyOtp } from './dto/verify-otp.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly otpService: OtpService,
    private readonly cartsService: CartsService,
    private readonly clubService: ClubService,
    private readonly smsService: SmsService,
    private readonly rahkaranService: RahkaranService,
  ) {}

  async sendCode(sendOtpDto: SendOtpDto) {
    return this.otpService.sendOtp(sendOtpDto.phone);
  }

  async login(
    sendVerifyOtp: SendVerifyOtp,
    guestId: string | undefined,
    response: Response,
  ) {
    const user = await this.usersService.findWithPhone(sendVerifyOtp.phone);

    // کد همیشه بررسی میشود (چه کاربر وجود داشته باشد چه نه) تا پیام «کد
    // اشتباه» در دو حالت یکسان باشد. اگر حسابی وجود نداشته باشد کد مصرف
    // نمیشود: فرانت به مرحلهی تکمیل ثبتنام میرود و همان کد را در
    // /auth/sign-up ارسال میکند.
    await this.otpService.verifyOtp(sendVerifyOtp.phone, sendVerifyOtp.code, {
      consume: Boolean(user),
    });

    if (!user) {
      return {
        message: 'signup_required',
        data: {
          signupRequired: true,
          expiresIn: await this.otpService.getRemainingTtl(sendVerifyOtp.phone),
        },
      };
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
    // اول کد بررسی میشود (بدون مصرف) تا نتوان صرفاً با ارسال یک کد دلخواه
    // فهمید شمارهای قبلاً ثبت شده یا نه. در خطای «شماره تکراری» هم کد نسوزد.
    await this.otpService.verifyOtp(createUserDto.phone, createUserDto.code, {
      consume: false,
    });

    const user = await this.usersService.findWithPhone(createUserDto.phone);

    if (user) {
      throw new BadRequestException('کاربر با این شماره تلفن وجود دارد');
    }

    const email = this.normalizeEmail(createUserDto.email);
    const birthDate = this.normalizeBirthDate(createUserDto.birthDate);

    // ستون email unique است؛ بدون این چک، ایمیل تکراری خطای ۵۰۰ دیتابیس میدهد.
    // قبل از مصرف کد انجام میشود تا کاربر بتواند ایمیل را اصلاح و دوباره تلاش کند.
    if (email) {
      const userEmail = await this.usersService.findWithEmail(email);
      if (userEmail) {
        throw new BadRequestException('کاربر با این ایمیل وجود دارد');
      }
    }

    await this.otpService.consumeOtp(createUserDto.phone);

    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);

    const newUser = await this.usersService.create({
      ...createUserDto,
      email,
      birthDate,
      password: hashedPassword,
    });

    try {
      await this.rahkaranService.createLoyaltyMemberForUser(newUser.id);
    } catch (err) {
      this.logger.log(err);
    }
    const [firstName, ...lastNameParts] = createUserDto.fullName
      .trim()
      .split(' ');
    const lastName = lastNameParts.join(' ') || '';

    // ثبت غیرهمزمان (اجرا در پس‌زمینه) برای عدم تأخیر در پاسخ
    try {
      await this.clubService.registerCustomer({
        firstName: firstName,
        lastName: lastName,
        customerCode: createUserDto.phone,
        email: email ?? undefined,
        birthDate,
      });
    } catch (err) {
      this.logger.log(err);
    }

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

  async refresh(refreshToken: string | undefined, response: Response) {
    if (!refreshToken) {
      throw new UnauthorizedException('refresh token not found');
    }

    let payload: { sub: number };

    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });
    } catch {
      // توکن ناموجود/منقضی/دستکاریشده نباید 500 بدهد؛ فرانت با 401 لاگاوت میکند
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.usersService.findOne(payload?.sub);

    if (!user) {
      throw new UnauthorizedException('user not found');
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

    await this.usersService.updateUser(
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

  /** ایمیل اختیاری است: خالی/فقط فاصله → null، در غیر این صورت trim شده. */
  private normalizeEmail(email?: string | null): string | null {
    const trimmed = email?.trim();
    return trimmed ? trimmed : null;
  }

  /**
   * فرانت برای تاریخ تولد خالی رشته‌ی `''` میفرستد؛ ذخیره‌ی آن در ستون
   * datetime خطا میدهد. مقدار خالی/نامعتبر را حذف و بقیه را ISO یکدست میکنیم.
   */
  private normalizeBirthDate(birthDate?: string): string | undefined {
    if (!birthDate) return undefined;
    const parsed = new Date(birthDate);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  private readonly accessCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // secure: false,
    sameSite: 'lax' as const,
    // همزمان با expiresIn: '6h' توکن — کوکی نباید زودتر از توکن حذف شود
    maxAge: 6 * 60 * 60 * 1000,
    path: '/',
  };

  private readonly refreshCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // secure: false,
    sameSite: 'lax' as const,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
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
