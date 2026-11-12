import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';

import { UpdateFirstPurchaseGiftDto } from './dto/update-first-purchase-gift.dto';
import { FirstPurchaseGiftService } from './first-purchase-gift.service';

@Controller('admin/first-purchase-gift')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class AdminFirstPurchaseGiftController {
  constructor(private readonly giftService: FirstPurchaseGiftService) {}

  @Get()
  getSettings() {
    return this.giftService.getAdminSettings();
  }

  @Patch()
  updateSettings(@Body() dto: UpdateFirstPurchaseGiftDto) {
    return this.giftService.updateSettings(dto);
  }
}
