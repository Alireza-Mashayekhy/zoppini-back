// src/orders/orders.admin.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { QueryDto } from 'src/common/query';

import { OrderStatus } from './entities/order.entity';
import { OrdersService } from './order.service';

@Controller('admin/orders')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class AdminOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * پاسخ‌های پنل مدیر نباید hash رمز یا کد ملی مشتری را برگردانند.
   * نام، تلفن و ایمیل برای نمایش سفارش در پنل لازم‌اند و حفظ می‌شوند.
   */
  private sanitizeUser(user: any) {
    if (!user) {
      return user;
    }

    const { password: _password, nationalCode: _nationalCode, ...safe } = user;

    return safe;
  }

  private sanitizeOrder(order: any) {
    if (!order) {
      return order;
    }

    const { user, ...rest } = order;

    return { ...rest, user: this.sanitizeUser(user) };
  }

  // دریافت لیست تمام سفارشات (برای ادمین)
  @Get()
  async findAll(@Query() query: QueryDto) {
    const result = await this.ordersService.findAllForAdmin(query);

    return {
      ...result,
      data: result.data.map(order => this.sanitizeOrder(order)),
    };
  }

  // دریافت جزئیات یک سفارش (برای ادمین)
  @Get(':id')
  async findOne(@Param('id') id: number) {
    return this.sanitizeOrder(await this.ordersService.findOneForAdmin(id));
  }

  // تغییر وضعیت سفارش (ادمین)
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: number,
    @Body('status') status: OrderStatus,
  ) {
    return this.sanitizeOrder(
      await this.ordersService.updateStatus(id, status),
    );
  }

  // لغو سفارش توسط ادمین (با دلیل)
  @Patch(':id/admin-cancel')
  async adminCancelOrder(
    @Param('id') id: number,
    @Body('reason') reason?: string,
  ) {
    return this.sanitizeOrder(
      await this.ordersService.adminCancelOrder(id, reason),
    );
  }
}
