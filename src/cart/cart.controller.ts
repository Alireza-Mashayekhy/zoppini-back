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
import {
  AddRewardToCartDto,
  RejectCartRewardDto,
  SelectCartRewardDto,
} from 'src/promotions/dto/promotion.dto';
import { PromotionsService } from 'src/promotions/promotions.service';

import { CartsService } from './cart.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

@Controller('cart')
@UseGuards(OptionalAuthGuard)
export class CartsController {
  constructor(
    private readonly cartsService: CartsService,
    private readonly promotionsService: PromotionsService,
  ) {}

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

    const result = await this.cartsService.removeItemDetailed(
      userId,
      guestId,
      itemId,
    );

    return {
      data: result.cart,
      message:
        result.promotionNotices.length > 0 || result.lostReward.length > 0
          ? [
              ...result.promotionNotices,
              ...result.lostReward.map(
                reward =>
                  `هدیهٔ «${reward.name}» به ارزش ${reward.freeItemValue.toLocaleString('fa-IR')} تومان از سبد حذف شد.`,
              ),
            ].join(' ')
          : undefined,
      promotionNotices: result.promotionNotices,
      lostReward: result.lostReward,
    };
  }

  // =====================================================
  // پروموشن‌ها
  // =====================================================

  /** نشان‌دادن این‌که پاپ‌آپ پیش از سبد برای این وضعیت نمایش داده شد */
  @Post('promotions/popup-shown')
  async markPopupShown(@Request() req, @Body() body: { stateKey: string }) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];

    return this.cartsService.markPopupShown(userId, guestId, body.stateKey);
  }

  /** پذیرش یا رد پیشنهاد (بدون افزودن کالا) */
  @Post('promotions/:promotionId/accept')
  async acceptPromotion(
    @Request() req,
    @Param('promotionId') promotionId: number,
    @Body() body: { accepted?: boolean },
  ) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];

    return this.cartsService.acceptPromotion(
      userId,
      guestId,
      Number(promotionId),
      body?.accepted !== false,
    );
  }

  /** «نه ممنون» — پاپ‌آپ برای همان وضعیت سبد دیگر نمایش داده نشود */
  @Post('promotions/:promotionId/dismiss')
  async dismissPromotion(
    @Request() req,
    @Param('promotionId') promotionId: number,
  ) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];

    return this.cartsService.dismissPromotion(
      userId,
      guestId,
      Number(promotionId),
    );
  }

  /** افزودن هدیه به سبد (با اختیار انتخاب واریانت) */
  @Post('promotions/reward')
  async addReward(@Request() req, @Body() dto: AddRewardToCartDto) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];

    return this.cartsService.addRewardToCart(userId, guestId, {
      promotionId: dto.promotionId,
      variantId: dto.variantId,
      productId: dto.productId,
      quantity: dto.quantity,
    });
  }

  /** انتخاب کالای هدیه از بین گزینه‌ها و افزودن آن */
  @Post('promotions/reward/select')
  async selectReward(@Request() req, @Body() dto: SelectCartRewardDto) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];

    return this.cartsService.selectReward(userId, guestId, {
      promotionId: dto.promotionId,
      variantId: dto.variantId,
      quantity: dto.quantity,
    });
  }

  /** حذف هدیهٔ یک پروموشن */
  @Post('promotions/reward/remove')
  async removeReward(@Request() req, @Body() dto: RejectCartRewardDto) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];

    return this.cartsService.removeReward(userId, guestId, dto.promotionId);
  }

  @Delete('clear')
  async clearCart(@Request() req) {
    const userId = req.user?.id;
    const guestId = req.cookies?.guestId || req.headers['x-guest-id'];
    await this.cartsService.clearCart(userId, guestId);
    return { message: 'سبد خرید خالی شد' };
  }
}
