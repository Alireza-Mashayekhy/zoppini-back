import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';

import {
  CreatePromotionDto,
  ListPromotionsQueryDto,
  PreviewPromotionDto,
  UpdatePromotionDto,
} from '../dto/promotion.dto';
import { PromotionsService } from '../promotions.service';

@Controller('admin/promotions')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class AdminPromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get()
  findAll(@Query() query: ListPromotionsQueryDto) {
    return this.promotionsService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreatePromotionDto) {
    return this.promotionsService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePromotionDto,
  ) {
    return this.promotionsService.update(id, dto);
  }

  @Patch(':id/status')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { isActive: boolean },
  ) {
    return this.promotionsService.setActive(id, body.isActive === true);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.remove(id);
  }

  /** پیش‌نمایش کامل قبل از فعال‌سازی */
  @Post(':id/preview')
  preview(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PreviewPromotionDto,
  ) {
    return this.promotionsService.preview(id, dto);
  }

  /** سفارش‌هایی که از این پروموشن استفاده کرده‌اند */
  @Get(':id/redemptions')
  redemptions(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.findOrdersWithPromotion(id);
  }
}
