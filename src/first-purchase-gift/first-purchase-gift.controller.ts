import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { OptionalAuthGuard } from 'src/common/guards/optional-auth.guard';

import { FirstPurchaseGiftService } from './first-purchase-gift.service';

@Controller('first-purchase-gift')
@UseGuards(OptionalAuthGuard)
export class FirstPurchaseGiftController {
  constructor(private readonly giftService: FirstPurchaseGiftService) {}

  @Get('public')
  getPublicConfig() {
    return this.giftService.getPublicConfig();
  }

  @Get('eligibility')
  getEligibility(@Request() req) {
    return this.giftService.getEligibility(req.user?.id);
  }
}
