// src/orders/orders.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from 'src/common/guards/auth.guard';

import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './order.service';

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  async findAll(@Request() req) {
    const userId = req.user.id;
    return this.ordersService.findAll(userId);
  }

  @Get(':id')
  async findOne(@Param('id') id: number, @Request() req) {
    const userId = req.user.id;
    return this.ordersService.findOne(id, userId);
  }

  @Post()
  async create(@Request() req, @Body() dto: CreateOrderDto) {
    const userId = req.user.id;
    return this.ordersService.createOrder(userId, dto);
  }

  @Patch(':id/cancel')
  async cancelOrder(@Param('id') id: number, @Request() req) {
    const userId = req.user.id;
    return this.ordersService.cancelOrder(id, userId);
  }
}
