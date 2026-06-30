// src/carts/carts.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuthGuard } from 'src/common/guards/optional-auth.guard';

import { CartsService } from './cart.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

@Controller('cart')
@UseGuards(OptionalAuthGuard)
export class CartsController {
  constructor(private readonly cartsService: CartsService) {}

  @Get()
  async getCart(@Request() req) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];
    return this.cartsService.getCart(userId, guestId);
  }

  @Post('add')
  async addToCart(@Request() req, @Body() dto: AddToCartDto) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];
    return this.cartsService.addToCart(userId, guestId, dto);
  }

  @Patch('item/:itemId')
  async updateItem(
    @Request() req,
    @Param('itemId') itemId: number,
    @Body() dto: UpdateCartItemDto,
  ) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];
    return this.cartsService.updateItemQuantity(userId, guestId, itemId, dto);
  }

  @Delete('item/:itemId')
  async removeItem(@Request() req, @Param('itemId') itemId: number) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];
    return this.cartsService.removeItem(userId, guestId, itemId);
  }

  @Delete('clear')
  async clearCart(@Request() req) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];
    await this.cartsService.clearCart(userId, guestId);
    return { message: 'سبد خرید خالی شد' };
  }
}
