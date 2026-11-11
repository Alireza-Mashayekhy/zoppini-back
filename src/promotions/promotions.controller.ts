import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuthGuard } from 'src/common/guards/optional-auth.guard';
import { ProductsService } from 'src/products/products.service';

import { PromotionPreviewDto } from './dto/public-promotion.dto';
import { PromotionsService } from './promotions.service';

/**
 * API عمومی پروموشن‌ها:
 * - نشان‌های محصول (کارت محصول و صفحهٔ محصول)
 * - پیشنهاد پیش از سبد
 * - پاسخ به پیشنهاد (پذیرش/رد)
 */
@Controller('promotions')
@UseGuards(OptionalAuthGuard)
export class PromotionsController {
  constructor(
    private readonly promotionsService: PromotionsService,
    private readonly productsService: ProductsService,
  ) {}

  /** نشان‌های فعال برای یک محصول (بر اساس اسلاگ) */
  @Get('product-badges')
  async productBadges(@Query('slug') slug: string) {
    if (!slug) {
      return { data: [] };
    }

    const { product } = await this.productsService.findOne(slug);

    const badges = await this.promotionsService.getProductBadges(product);

    return { data: badges };
  }

  /** پیش‌نمایش یک پروموشن با یک سبد آزمایشی (برای تست ادمین/پشتیبانی) */
  @Post('simulate')
  simulate(@Body() dto: PromotionPreviewDto) {
    return this.promotionsService.simulate(dto);
  }

  /** پیشنهادهای فعال برای سبد فعلی */
  @Get('suggestions')
  async suggestions(@Request() req) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];

    return this.promotionsService.cartSuggestions({ userId, guestId });
  }
}
