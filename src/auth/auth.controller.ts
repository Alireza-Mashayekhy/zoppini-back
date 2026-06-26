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
import { CreateUserDto } from 'src/users/dto/create-user.dto';

import { AuthService } from './auth.service';
import { LoginWithPasswordDto } from './dto/login-with-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { SendVerifyOtp } from './dto/verify-otp.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('/send-otp')
  sendOtp(@Body() sendOtpDto: SendOtpDto) {
    return this.authService.sendCode(sendOtpDto);
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
    const guestId = request.cookies?.guestId || request.headers['x-guest-id'];
    return this.authService.login(sendVerifyOtp, guestId, response);
  }

  @Post('/sign-up')
  signUp(
    @Body() createUserDto: CreateUserDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const guestId = request.cookies?.guestId || request.headers['x-guest-id'];
    return this.authService.signUp(createUserDto, guestId, response);
  }

  @Post('login-password')
  loginWithPassword(
    @Body() dto: LoginWithPasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const guestId = request.cookies?.guestId || request.headers['x-guest-id'];
    return this.authService.loginWithPassword(dto, guestId, response);
  }

  @Post('/refresh')
  refresh(
    @Req() request: Request,
    @Res({ passthrough: true })
    response: Response,
  ) {
    return this.authService.refresh(request.cookies.refresh_token, response);
  }

  @Post('/logout')
  logout(
    @Res({ passthrough: true })
    response: Response,
  ) {
    return this.authService.logout(response);
  }

  @Post('forgot-password')
  forgotPassword(@Body() dto: SendOtpDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}
