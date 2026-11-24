import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Response } from 'express';
import { CartsService } from 'src/cart/cart.service';
import { ClubService } from 'src/club/club.service';
import { Role } from 'src/common/enum/role.enum';
import {
  createCorrelationId,
  maskMobile,
  serializeError,
  structuredLog,
} from 'src/common/logging/structured-logger';
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

const DB_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOTFOUND',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ER_CON_COUNT_ERROR',
]);

function isInfrastructureDbError(error: unknown): boolean {
  const err = error as {
    code?: string;
    name?: string;
    driverError?: { code?: string };
  };
  const code = err?.code ?? err?.driverError?.code;
  if (typeof code === 'string' && DB_UNAVAILABLE_CODES.has(code)) {
    return true;
  }
  return err?.name === 'ConnectionNotFoundError';
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly phoneInFlight = new Set<string>();

  constructor(
    private jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly otpService: OtpService,
    private readonly cartsService: CartsService,
    private readonly clubService: ClubService,
    private readonly smsService: SmsService,
    private readonly rahkaranService: RahkaranService,
  ) {}

  private async withPhoneLock<T>(
    phone: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.phoneInFlight.has(phone)) {
      throw new ConflictException(
        'درخواست تأیید کد در حال پردازش است؛ لطفاً چند لحظه صبر کنید',
      );
    }

    this.phoneInFlight.add(phone);
    try {
      return await fn();
    } finally {
      this.phoneInFlight.delete(phone);
    }
  }

  private rethrowNormalizedAuthError(error: unknown): never {
    if (error instanceof HttpException) {
      throw error;
    }

    if (isInfrastructureDbError(error)) {
      throw new ServiceUnavailableException(
        'سرویس موقتاً در دسترس نیست؛ لطفاً چند لحظه دیگر تلاش کنید',
      );
    }

    throw error;
  }

  async sendCode(sendOtpDto: SendOtpDto, correlationId?: string) {
    const cid = correlationId || createCorrelationId('auth-otp');
    try {
      const result = await this.otpService.sendOtp(sendOtpDto.phone);
      this.logger.log(
        structuredLog('auth.otp.sent', {
          operation: 'SEND_OTP',
          correlationId: cid,
          phone: maskMobile(sendOtpDto.phone),
          stage: 'completed',
          otpResult: result.data.sent ? 'sent' : 'already_active',
          expiresIn: result.data.expiresIn,
          timestamp: new Date().toISOString(),
        }),
      );
      return result;
    } catch (error) {
      this.logger.error(
        structuredLog('auth.otp.send_failed', {
          operation: 'SEND_OTP',
          correlationId: cid,
          phone: maskMobile(sendOtpDto.phone),
          stage: 'send_otp',
          otpResult: 'failed',
          error: serializeError(error),
          timestamp: new Date().toISOString(),
        }),
      );
      this.rethrowNormalizedAuthError(error);
    }
  }

  async login(
    sendVerifyOtp: SendVerifyOtp,
    guestId: string | undefined,
    response: Response,
    correlationId?: string,
  ) {
    const cid = correlationId || createCorrelationId('auth-login');
    let stage = 'lock_acquire';
    let otpResult = 'not_verified';
    let userResult = 'not_checked';

    try {
      return await this.withPhoneLock(sendVerifyOtp.phone, async () => {
        stage = 'user_lookup';
        const user = await this.usersService.findWithPhone(sendVerifyOtp.phone);
        userResult = user ? 'found' : 'not_found';

        // کد همیشه بررسی می‌شود (چه کاربر وجود داشته باشد چه نه) تا پیام «کد
        // اشتباه» در دو حالت یکسان باشد. کد تا پایان موفق فرایند مصرف نمی‌شود
        // تا در صورت خطای وضعیت کاربر یا تولید توکن، کد معتبر نسوزد.
        stage = 'otp_verify';
        await this.otpService.verifyOtp(
          sendVerifyOtp.phone,
          sendVerifyOtp.code,
          { consume: false },
        );
        otpResult = 'verified';

        if (!user) {
          stage = 'ttl_lookup';
          const expiresIn = await this.otpService.getRemainingTtl(
            sendVerifyOtp.phone,
          );

          this.logger.log(
            structuredLog('auth.login.signup_required', {
              operation: 'LOGIN',
              correlationId: cid,
              phone: maskMobile(sendVerifyOtp.phone),
              stage: 'completed',
              otpResult: 'verified_preserved',
              userResult: 'not_found',
              rahkaranResult: 'not_applicable',
              expiresIn,
              timestamp: new Date().toISOString(),
            }),
          );

          return {
            message: 'signup_required',
            data: {
              signupRequired: true,
              expiresIn,
            },
          };
        }

        stage = 'user_status_check';
        if (user.isActive === false) {
          userResult = 'inactive';
          throw new ForbiddenException('حساب کاربری شما غیرفعال شده است');
        }

        stage = 'token_issue';
        const accessToken = await this.generateAccessToken(user);
        const refreshToken = await this.generateRefreshToken(user);

        stage = 'otp_consume';
        const consumed = await this.otpService.consumeOtp(sendVerifyOtp.phone);
        if (consumed === false) {
          otpResult = 'already_consumed_or_expired';
          throw new BadRequestException('کد منقضی شده است');
        }
        otpResult = 'consumed';

        // ادغام سبد خرید مهمان (غیرمسدودکننده تا خطای سبد مانع ورود نشود)
        if (guestId) {
          stage = 'cart_merge';
          try {
            await this.cartsService.mergeGuestCart(user.id, guestId);
            response.clearCookie('guestId', { path: '/' });
          } catch (cartError) {
            this.logger.warn(
              structuredLog('auth.login.cart_merge_failed', {
                operation: 'LOGIN',
                correlationId: cid,
                userId: user.id,
                phone: maskMobile(sendVerifyOtp.phone),
                stage: 'cart_merge',
                error: serializeError(cartError),
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }

        stage = 'cookie_set';
        response.cookie('access_token', accessToken, this.accessCookieOptions);
        response.cookie(
          'refresh_token',
          refreshToken,
          this.refreshCookieOptions,
        );

        this.logger.log(
          structuredLog('auth.login.succeeded', {
            operation: 'LOGIN',
            correlationId: cid,
            userId: user.id,
            phone: maskMobile(sendVerifyOtp.phone),
            stage: 'completed',
            otpResult: 'consumed',
            userResult: 'authenticated',
            rahkaranResult: 'not_applicable',
            timestamp: new Date().toISOString(),
          }),
        );

        return {
          message: 'login successfully',
        };
      });
    } catch (error) {
      if (otpResult === 'not_verified' && stage === 'otp_verify') {
        otpResult = 'rejected';
      }

      this.logger.error(
        structuredLog('auth.login.failed', {
          operation: 'LOGIN',
          correlationId: cid,
          phone: maskMobile(sendVerifyOtp?.phone),
          stage,
          otpResult,
          userResult,
          rahkaranResult: 'not_applicable',
          error: serializeError(error),
          timestamp: new Date().toISOString(),
        }),
      );

      this.rethrowNormalizedAuthError(error);
    }
  }

  async signUp(
    createUserDto: CreateUserDto,
    guestId: string | undefined,
    response: Response,
    correlationId?: string,
  ) {
    const cid = correlationId || createCorrelationId('auth-register');
    let stage = 'lock_acquire';
    let otpResult = 'not_verified';
    let userResult = 'not_created';
    let rahkaranResult: 'not_started' | 'synced' | 'already_synced' | 'failed' =
      'not_started';
    let clubResult: 'not_started' | 'synced' | 'failed' = 'not_started';

    try {
      return await this.withPhoneLock(createUserDto.phone, async () => {
        // اول کد بررسی می‌شود (بدون مصرف) تا نتوان صرفاً با ارسال یک کد دلخواه
        // فهمید شماره‌ای قبلاً ثبت شده یا نه، و در صورت بروز هر خطای اعتبارسنجی
        // یا دیتابیس پیش از ساخت کاربر، کد نسوزد.
        stage = 'otp_verify';
        await this.otpService.verifyOtp(
          createUserDto.phone,
          createUserDto.code,
          { consume: false },
        );
        otpResult = 'verified';

        stage = 'duplicate_phone_check';
        const user = await this.usersService.findWithPhone(createUserDto.phone);

        if (user) {
          userResult = 'duplicate_phone';
          throw new BadRequestException('کاربر با این شماره تلفن وجود دارد');
        }

        const email = this.normalizeEmail(createUserDto.email);
        const birthDate = this.normalizeBirthDate(createUserDto.birthDate);
        const fullName = (createUserDto.fullName ?? '').trim();

        // ستون email unique است؛ بدون این چک، ایمیل تکراری خطای دیتابیس می‌دهد.
        // قبل از مصرف کد انجام می‌شود تا کاربر بتواند ایمیل را اصلاح و دوباره تلاش کند.
        if (email) {
          stage = 'duplicate_email_check';
          const userEmail = await this.usersService.findWithEmail(email);
          if (userEmail) {
            userResult = 'duplicate_email';
            throw new BadRequestException('کاربر با این ایمیل وجود دارد');
          }
        }

        stage = 'password_hash';
        const hashedPassword = await bcrypt.hash(createUserDto.password, 10);

        stage = 'user_create';
        const newUser = await this.usersService.create({
          ...createUserDto,
          fullName,
          email,
          birthDate,
          password: hashedPassword,
        });
        userResult = 'created';

        stage = 'token_issue';
        const accessToken = await this.generateAccessToken(newUser);
        const refreshToken = await this.generateRefreshToken(newUser);

        stage = 'otp_consume';
        const consumed = await this.otpService.consumeOtp(createUserDto.phone);
        if (consumed === false) {
          otpResult = 'already_consumed_or_expired';
          throw new BadRequestException('کد منقضی شده است');
        }
        otpResult = 'consumed';

        /*
         * ثبت در راهکاران نباید ثبت‌نام را بشکند، ولی خطا باید قابل پیگیری
         * باشد: شناسهٔ کاربر، موبایل ماسک‌شده، correlationId و مرحله.
         * `createLoyaltyMemberForUser` idempotent است، پس فراخوانی دوباره
         * (نظرسنجی/retry) مشتری یا عضو تکراری نمی‌سازد.
         */
        stage = 'rahkaran_sync';
        try {
          const loyaltySync =
            await this.rahkaranService.createLoyaltyMemberForUser(newUser.id);
          rahkaranResult =
            loyaltySync?.skipped === 'already_synced'
              ? 'already_synced'
              : 'synced';
        } catch (err) {
          rahkaranResult = 'failed';
          this.logger.error(
            structuredLog('rahkaran.loyalty.failed', {
              operation: 'REGISTER',
              correlationId: cid,
              stage: 'signup',
              userId: newUser.id,
              customerMobile: maskMobile(createUserDto.phone),
              otpResult,
              userResult,
              rahkaranResult,
              error: serializeError(err),
              timestamp: new Date().toISOString(),
              note: 'ثبت‌نام ادامه می‌یابد؛ ثبت در راهکاران با فراخوانی بعدی تکمیل می‌شود.',
            }),
          );
        }

        const [firstName, ...lastNameParts] = fullName.split(' ');
        const lastName = lastNameParts.join(' ') || '';

        stage = 'club_sync';
        try {
          await this.clubService.registerCustomer({
            firstName: firstName,
            lastName: lastName,
            customerCode: createUserDto.phone,
            email: email ?? undefined,
            birthDate,
          });
          clubResult = 'synced';
        } catch (err) {
          clubResult = 'failed';
          this.logger.error(
            structuredLog('diatech.customer.registration.failed', {
              operation: 'REGISTER',
              correlationId: cid,
              stage: 'signup',
              userId: newUser.id,
              customerMobile: maskMobile(createUserDto.phone),
              error: serializeError(err),
              timestamp: new Date().toISOString(),
            }),
          );
        }

        // ادغام سبد خرید مهمان (غیرمسدودکننده)
        if (guestId) {
          stage = 'cart_merge';
          try {
            await this.cartsService.mergeGuestCart(newUser.id, guestId);
            response.clearCookie('guestId', { path: '/' });
          } catch (cartError) {
            this.logger.warn(
              structuredLog('auth.register.cart_merge_failed', {
                operation: 'REGISTER',
                correlationId: cid,
                userId: newUser.id,
                phone: maskMobile(createUserDto.phone),
                stage: 'cart_merge',
                error: serializeError(cartError),
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }

        stage = 'cookie_set';
        response.cookie('access_token', accessToken, this.accessCookieOptions);
        response.cookie(
          'refresh_token',
          refreshToken,
          this.refreshCookieOptions,
        );

        this.logger.log(
          structuredLog('auth.register.succeeded', {
            operation: 'REGISTER',
            correlationId: cid,
            userId: newUser.id,
            phone: maskMobile(createUserDto.phone),
            stage: 'completed',
            otpResult: 'consumed',
            userResult: 'created',
            rahkaranResult,
            clubResult,
            timestamp: new Date().toISOString(),
          }),
        );

        return {
          message: 'sign up successfully',
        };
      });
    } catch (error) {
      if (otpResult === 'not_verified' && stage === 'otp_verify') {
        otpResult = 'rejected';
      }

      this.logger.error(
        structuredLog('auth.register.failed', {
          operation: 'REGISTER',
          correlationId: cid,
          phone: maskMobile(createUserDto?.phone),
          stage,
          otpResult,
          userResult,
          rahkaranResult,
          error: serializeError(error),
          timestamp: new Date().toISOString(),
        }),
      );

      this.rethrowNormalizedAuthError(error);
    }
  }

  async loginWithPassword(
    dto: LoginWithPasswordDto,
    guestId: string | undefined,
    response: Response,
    correlationId?: string,
  ) {
    const cid = correlationId || createCorrelationId('auth-pass-login');
    let stage = 'user_lookup';

    try {
      const user = await this.usersService.findWithPhone(dto.phone);

      if (!user) {
        throw new BadRequestException('شماره تلفن یا رمز عبور اشتباه است');
      }

      stage = 'password_verify';
      const isMatch = await bcrypt.compare(dto.password, user.password);

      if (!isMatch) {
        throw new BadRequestException('شماره تلفن یا رمز عبور اشتباه است');
      }

      stage = 'user_status_check';
      if (user.isActive === false) {
        throw new ForbiddenException('حساب کاربری شما غیرفعال شده است');
      }

      stage = 'token_issue';
      const accessToken = await this.generateAccessToken(user);
      const refreshToken = await this.generateRefreshToken(user);

      // ادغام سبد خرید مهمان
      if (guestId) {
        stage = 'cart_merge';
        try {
          await this.cartsService.mergeGuestCart(user.id, guestId);
          response.clearCookie('guestId', { path: '/' });
        } catch (cartError) {
          this.logger.warn(
            structuredLog('auth.login_password.cart_merge_failed', {
              operation: 'LOGIN_PASSWORD',
              correlationId: cid,
              userId: user.id,
              phone: maskMobile(dto.phone),
              stage: 'cart_merge',
              error: serializeError(cartError),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }

      response.cookie('access_token', accessToken, this.accessCookieOptions);
      response.cookie('refresh_token', refreshToken, this.refreshCookieOptions);

      this.logger.log(
        structuredLog('auth.login_password.succeeded', {
          operation: 'LOGIN_PASSWORD',
          correlationId: cid,
          userId: user.id,
          phone: maskMobile(dto.phone),
          stage: 'completed',
          timestamp: new Date().toISOString(),
        }),
      );

      return {
        message: 'login successfully',
      };
    } catch (error) {
      this.logger.error(
        structuredLog('auth.login_password.failed', {
          operation: 'LOGIN_PASSWORD',
          correlationId: cid,
          phone: maskMobile(dto?.phone),
          stage,
          error: serializeError(error),
          timestamp: new Date().toISOString(),
        }),
      );

      this.rethrowNormalizedAuthError(error);
    }
  }

  async refresh(
    refreshToken: string | undefined,
    response: Response,
    correlationId?: string,
  ) {
    const cid = correlationId || createCorrelationId('auth-refresh');

    if (!refreshToken) {
      throw new UnauthorizedException('refresh token not found');
    }

    let payload: { sub: number };

    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });
    } catch {
      // توکن ناموجود/منقضی/دستکاری‌شده نباید 500 بدهد؛ فرانت با 401 لاگ‌اوت می‌کند
      throw new UnauthorizedException('Invalid refresh token');
    }

    try {
      const user = await this.usersService.findOne(payload?.sub);

      if (!user) {
        throw new UnauthorizedException('user not found');
      }

      if (user.isActive === false) {
        throw new UnauthorizedException('user account is inactive');
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
    } catch (error) {
      this.logger.error(
        structuredLog('auth.refresh.failed', {
          operation: 'REFRESH',
          correlationId: cid,
          userId: payload?.sub,
          error: serializeError(error),
          timestamp: new Date().toISOString(),
        }),
      );

      this.rethrowNormalizedAuthError(error);
    }
  }

  logout(response: Response) {
    response.clearCookie('access_token', { path: '/' });
    response.clearCookie('refresh_token', { path: '/' });

    return {
      message: 'logout success',
    };
  }

  async forgotPassword(dto: SendOtpDto, correlationId?: string) {
    const cid = correlationId || createCorrelationId('auth-forgot');
    try {
      const user = await this.usersService.findWithPhone(dto.phone);

      if (!user) {
        throw new BadRequestException('کاربری با این شماره تلفن یافت نشد.');
      }

      if (user.isActive === false) {
        throw new ForbiddenException('حساب کاربری شما غیرفعال شده است');
      }

      return await this.otpService.sendOtp(dto.phone);
    } catch (error) {
      this.logger.error(
        structuredLog('auth.forgot_password.failed', {
          operation: 'FORGOT_PASSWORD',
          correlationId: cid,
          phone: maskMobile(dto?.phone),
          error: serializeError(error),
          timestamp: new Date().toISOString(),
        }),
      );
      this.rethrowNormalizedAuthError(error);
    }
  }

  async resetPassword(dto: ResetPasswordDto, correlationId?: string) {
    const cid = correlationId || createCorrelationId('auth-reset');
    let stage = 'lock_acquire';

    try {
      return await this.withPhoneLock(dto.phone, async () => {
        stage = 'otp_verify';
        await this.otpService.verifyOtp(dto.phone, dto.code, {
          consume: false,
        });

        stage = 'user_lookup';
        const user = await this.usersService.findWithPhone(dto.phone);

        if (!user) {
          throw new BadRequestException('کاربری با این شماره تلفن یافت نشد.');
        }

        if (user.isActive === false) {
          throw new ForbiddenException('حساب کاربری شما غیرفعال شده است');
        }

        stage = 'password_hash';
        const hashedPassword = await bcrypt.hash(dto.newPassword, 10);

        stage = 'password_update';
        await this.usersService.updateUser(
          user.id,
          {
            password: hashedPassword,
          },
          user,
        );

        stage = 'otp_consume';
        const consumed = await this.otpService.consumeOtp(dto.phone);
        if (consumed === false) {
          throw new BadRequestException('کد منقضی شده است');
        }

        this.logger.log(
          structuredLog('auth.reset_password.succeeded', {
            operation: 'RESET_PASSWORD',
            correlationId: cid,
            userId: user.id,
            phone: maskMobile(dto.phone),
            stage: 'completed',
            timestamp: new Date().toISOString(),
          }),
        );

        return {
          message: 'password changed successfully',
        };
      });
    } catch (error) {
      this.logger.error(
        structuredLog('auth.reset_password.failed', {
          operation: 'RESET_PASSWORD',
          correlationId: cid,
          phone: maskMobile(dto?.phone),
          stage,
          error: serializeError(error),
          timestamp: new Date().toISOString(),
        }),
      );
      this.rethrowNormalizedAuthError(error);
    }
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
    sameSite: 'lax' as const,
    // همزمان با expiresIn: '6h' توکن — کوکی نباید زودتر از توکن حذف شود
    maxAge: 6 * 60 * 60 * 1000,
    path: '/',
  };

  private readonly refreshCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };

  private async generateAccessToken(user: User) {
    // eslint-disable-next-line unused-imports/no-unused-vars
    const { password, ...payload } = user;

    if ('roles' in payload) {
      payload.roles =
        Array.isArray(payload.roles) && payload.roles.length > 0
          ? payload.roles
          : [Role.User];
    }

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
