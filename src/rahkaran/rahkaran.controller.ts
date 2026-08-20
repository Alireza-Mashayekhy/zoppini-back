// src/rahkaran/rahkaran.controller.ts

import { Controller, Get, Post, UseGuards } from '@nestjs/common';

import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enum/role.enum';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { RahkaranService } from './rahkaran.service';

@Controller('rahkaran')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class RahkaranController {
  constructor(private readonly rahkaranService: RahkaranService) {}

  @Post('auth/login')
  async login() {
    await this.rahkaranService.login();

    return {
      success: true,
      message: 'اتصال به راهکاران با موفقیت انجام شد.',
      ...this.rahkaranService.getAuthState(),
    };
  }

  @Post('auth/tick')
  async tick() {
    const success = await this.rahkaranService.tick();

    return {
      success,
      ...this.rahkaranService.getAuthState(),
    };
  }

  @Get('auth/status')
  status() {
    return (
      this.rahkaranService.getAuthState() || {
        authenticated: false,
      }
    );
  }
}
