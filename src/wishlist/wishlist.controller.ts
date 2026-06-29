// src/wishlist/wishlist.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from 'src/common/guards/auth.guard';

import { AddToWishlistDto } from './dto/create-wishlist.dto';
import { WishlistService } from './wishlist.service';

@Controller('wishlist')
@UseGuards(AuthGuard)
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  // دریافت لیست کامل علاقه‌مندی‌ها
  @Get()
  async getWishlist(@Request() req) {
    const userId = req.user.id;
    return this.wishlistService.getUserWishlist(userId);
  }

  // دریافت فقط محصولات علاقه‌مندی (برای نمایش در صفحات)
  @Get('products')
  async getWishlistProducts(@Request() req) {
    const userId = req.user.id;
    return this.wishlistService.getUserWishlistProducts(userId);
  }

  // بررسی وجود محصول در علاقه‌مندی‌ها
  @Get('check/:productId')
  async checkWishlist(@Request() req, @Param('productId') productId: number) {
    const userId = req.user.id;
    const isInWishlist = await this.wishlistService.isProductInWishlist(
      userId,
      productId,
    );
    return { isInWishlist };
  }

  // تعداد علاقه‌مندی‌ها
  @Get('count')
  async countWishlist(@Request() req) {
    const userId = req.user.id;
    const count = await this.wishlistService.countUserWishlist(userId);
    return { count };
  }

  // اضافه کردن به علاقه‌مندی‌ها
  @Post()
  async addToWishlist(@Request() req, @Body() dto: AddToWishlistDto) {
    const userId = req.user.id;
    return this.wishlistService.addToWishlist(userId, dto);
  }

  // حذف از علاقه‌مندی‌ها
  @Delete(':productId')
  async removeFromWishlist(
    @Request() req,
    @Param('productId') productId: number,
  ) {
    const userId = req.user.id;
    await this.wishlistService.removeFromWishlist(userId, productId);
    return { message: 'با موفقیت از لیست علاقه‌مندی‌ها حذف شد' };
  }
}
