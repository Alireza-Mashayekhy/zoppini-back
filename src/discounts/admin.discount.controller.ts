import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';

import { DiscountService } from './discounts.service';
import { CreateDiscountDto } from './dto/create-discount.dto';
import { UpdateDiscountDto } from './dto/update-discount.dto';

@Controller('discounts/admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class AdminDiscountController {
  constructor(private readonly discountService: DiscountService) {}

  @Get()
  findAll() {
    return this.discountService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: number) {
    return this.discountService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateDiscountDto) {
    return this.discountService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: number, @Body() dto: UpdateDiscountDto) {
    return this.discountService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: number) {
    return this.discountService.remove(id);
  }
}
