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
import { AuthGuard } from 'src/common/guards/auth.guard';

import { CartsService } from './cart.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

@Controller('cart')
@UseGuards(AuthGuard)
export class CartsController {
  constructor(private readonly cartsService: CartsService) {}

  @Get()
  async getCart(@Request() req) {
    const userId = req.user.id;
    return this.cartsService.getCart(userId);
  }

  @Post('add')
  async addToCart(@Request() req, @Body() dto: AddToCartDto) {
    const userId = req.user.id;
    return this.cartsService.addToCart(userId, dto);
  }

  @Patch('item/:itemId')
  async updateItem(
    @Request() req,
    @Param('itemId') itemId: number,
    @Body() dto: UpdateCartItemDto,
  ) {
    const userId = req.user.id;
    return this.cartsService.updateItemQuantity(userId, itemId, dto);
  }

  @Delete('item/:itemId')
  async removeItem(@Request() req, @Param('itemId') itemId: number) {
    const userId = req.user.id;
    return this.cartsService.removeItem(userId, itemId);
  }

  @Delete('clear')
  async clearCart(@Request() req) {
    const userId = req.user.id;
    await this.cartsService.clearCart(userId);
    return { message: 'سبد خرید خالی شد' };
  }
}
