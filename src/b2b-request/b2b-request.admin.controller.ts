import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';

import { B2BService } from './b2b-request.service';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin/b2b')
export class B2bAdminController {
  constructor(private readonly b2bService: B2BService) {}

  // مسیر مدیریتی برای مشاهده لیست درخواست‌ها (فقط ادمین)
  @Get()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async findAll() {
    return this.b2bService.findAll();
  }

  // مسیر مدیریتی برای مشاهده جزئیات یک درخواست (فقط ادمین)
  @Get(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async findOne(@Param('id') id: number) {
    return this.b2bService.findOne(id);
  }

  // مسیر مدیریتی برای حذف درخواست (فقط ادمین)
  @Delete(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async remove(@Param('id') id: number) {
    await this.b2bService.remove(id);
    return { message: 'درخواست با موفقیت حذف شد' };
  }
}
