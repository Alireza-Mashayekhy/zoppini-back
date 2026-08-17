import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from 'src/common/guards/auth.guard';

import { DiscountService } from './discounts.service';

@Controller('discounts')
export class DiscountController {
  constructor(private readonly discountService: DiscountService) {}

  @Post('apply')
  @UseGuards(AuthGuard)
  async applyDiscount(@Req() req, @Body() body: { code: string }) {
    const userId = req.user?.id;

    if (!userId) {
      throw new Error('کاربر احراز هویت نشده است.');
    }

    if (!body.code?.trim()) {
      throw new Error('کد تخفیف الزامی است.');
    }

    return this.discountService.applyDiscountToCart(Number(userId), body.code);
  }
}
