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

  // دریافت لیست تمام سفارشات (برای ادمین)
  @Get()
  async findAll(@Query() query: QueryDto) {
    return this.ordersService.findAllForAdmin(query);
  }

  // دریافت جزئیات یک سفارش (برای ادمین)
  @Get(':id')
  async findOne(@Param('id') id: number) {
    return this.ordersService.findOneForAdmin(id);
  }

  // تغییر وضعیت سفارش (ادمین)
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: number,
    @Body('status') status: OrderStatus,
  ) {
    return this.ordersService.updateStatus(id, status);
  }

  // لغو سفارش توسط ادمین (با دلیل)
  @Patch(':id/admin-cancel')
  async adminCancelOrder(
    @Param('id') id: number,
    @Body('reason') reason?: string,
  ) {
    return this.ordersService.adminCancelOrder(id, reason);
  }
}
