// src/orders/orders.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AnalyticsService } from 'src/analytics/analytics.service';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { QueryDto } from 'src/common/query';
import { verifyAttribution } from 'src/torob/torob-attribution.util';

import { CreateOrderDto, ShippingMethod } from './dto/create-order.dto';
import { OrdersService } from './order.service';

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  /**
   * پیش‌نمایش زندهٔ مبالغ چک‌اوت با پروموشن‌های فعلی.
   * باید پیش از `@Get(':id')` ثبت شود تا «checkout-preview» شناسه تلقی نشود.
   */
  @Get('checkout-preview')
  async checkoutPreview(
    @Request() req,
    @Query('shippingMethod') shippingMethod?: ShippingMethod,
  ) {
    return this.ordersService.previewCheckout(req.user.id, {
      shippingMethod,
    });
  }

  @Get()
  async findAll(@Request() req, @Query() query: QueryDto) {
    const userId = req.user.id;
    return this.ordersService.findAll(userId, query);
  }

  @Get(':id')
  async findOne(@Param('id') id: number, @Request() req) {
    const userId = req.user.id;
    return this.ordersService.findOne(id, userId);
  }

  @Post()
  async create(@Request() req, @Body() dto: CreateOrderDto) {
    const userId = req.user.id;
    const attribution =
      process.env.TOROB_TRACKING_ENABLED === 'true'
        ? verifyAttribution(
            req.headers['x-torob-attribution'],
            process.env.TOROB_ATTRIBUTION_SECRET,
          )
        : null;
    return this.ordersService.createOrder(
      userId,
      dto,
      attribution,
      String(req.headers['x-analytics-context'] ?? ''),
    );
  }

  @Patch(':id/cancel')
  async cancelOrder(@Param('id') id: number, @Request() req) {
    const userId = req.user.id;
    return this.ordersService.cancelOrder(id, userId);
  }

  @Post(':id/confirm-from-wallet')
  async confirmFromWallet(@Param('id') id: number, @Request() req) {
    const userId = req.user.id;
    await this.analyticsService.checkout(
      id,
      userId,
      String(req.headers['x-analytics-context'] ?? ''),
    );
    return this.ordersService.confirmOrderFromWallet(id, userId);
  }
}
