import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { createCorrelationId } from 'src/common/logging/structured-logger';
import { CreateUserDto } from 'src/users/dto/create-user.dto';

import { AuthService } from './auth.service';
import { LoginWithPasswordDto } from './dto/login-with-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { SendVerifyOtp } from './dto/verify-otp.dto';

function resolveGuestId(request: Request): string | undefined {
  const cookieGuestId = request?.cookies?.guestId;
  if (typeof cookieGuestId === 'string' && cookieGuestId.trim()) {
    return cookieGuestId.trim();
  }

  const headerGuestId = request?.headers?.['x-guest-id'];
  const raw = Array.isArray(headerGuestId) ? headerGuestId[0] : headerGuestId;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }

  return undefined;
}

function resolveCorrelationId(
  request: Request | undefined,
  response: Response | undefined,
  prefix = 'auth',
): string {
  const incoming =
    request?.headers?.['x-correlation-id'] ??
    request?.headers?.['x-request-id'];
  const raw = Array.isArray(incoming) ? incoming[0] : incoming;
  const sanitized =
    typeof raw === 'string' && /^[a-zA-Z0-9._:-]{4,64}$/.test(raw.trim())
      ? raw.trim()
      : createCorrelationId(prefix);

  if (typeof response?.setHeader === 'function') {
    response.setHeader('X-Correlation-Id', sanitized);
  }

  return sanitized;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('/send-otp')
  sendOtp(
    @Body() sendOtpDto: SendOtpDto,
    @Req() request?: Request,
    @Res({ passthrough: true }) response?: Response,
  ) {
    const correlationId = resolveCorrelationId(request, response, 'auth-otp');
    return this.authService.sendCode(sendOtpDto, correlationId);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() request: Request & { user: any }) {
    return {
      data: request.user,
    };
  }

  @Post('/login')
  login(
    @Body() sendVerifyOtp: SendVerifyOtp,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const guestId = resolveGuestId(request);
    const correlationId = resolveCorrelationId(request, response, 'auth-login');
    return this.authService.login(
      sendVerifyOtp,
      guestId,
      response,
      correlationId,
    );
  }

  @Post('/sign-up')
  signUp(
    @Body() createUserDto: CreateUserDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const guestId = resolveGuestId(request);
    const correlationId = resolveCorrelationId(
      request,
      response,
      'auth-register',
    );
    return this.authService.signUp(
      createUserDto,
      guestId,
      response,
      correlationId,
    );
  }

  @Post('login-password')
  loginWithPassword(
    @Body() dto: LoginWithPasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const guestId = resolveGuestId(request);
    const correlationId = resolveCorrelationId(
      request,
      response,
      'auth-pass-login',
    );
    return this.authService.loginWithPassword(
      dto,
      guestId,
      response,
      correlationId,
    );
  }

  @Post('/refresh')
  refresh(
    @Req() request: Request,
    @Res({ passthrough: true })
    response: Response,
  ) {
    const correlationId = resolveCorrelationId(
      request,
      response,
      'auth-refresh',
    );
    return this.authService.refresh(
      request?.cookies?.refresh_token,
      response,
      correlationId,
    );
  }

  @Post('/logout')
  logout(
    @Res({ passthrough: true })
    response: Response,
  ) {
    return this.authService.logout(response);
  }

  @Post('forgot-password')
  forgotPassword(
    @Body() dto: SendOtpDto,
    @Req() request?: Request,
    @Res({ passthrough: true }) response?: Response,
  ) {
    const correlationId = resolveCorrelationId(
      request,
      response,
      'auth-forgot',
    );
    return this.authService.forgotPassword(dto, correlationId);
  }

  @Post('reset-password')
  resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() request?: Request,
    @Res({ passthrough: true }) response?: Response,
  ) {
    const correlationId = resolveCorrelationId(request, response, 'auth-reset');
    return this.authService.resetPassword(dto, correlationId);
  }
}
