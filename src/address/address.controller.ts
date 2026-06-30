// src/addresses/addresses.controller.ts
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

import { AddressesService } from './address.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

@Controller('addresses')
@UseGuards(AuthGuard)
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  @Get()
  async getAddresses(@Request() req) {
    const userId = req.user.id;
    return this.addressesService.getAddresses(userId);
  }

  @Get(':id')
  async getAddress(@Param('id') id: number, @Request() req) {
    const userId = req.user.id;
    return this.addressesService.getAddress(id, userId);
  }

  @Post()
  async createAddress(@Request() req, @Body() dto: CreateAddressDto) {
    const userId = req.user.id;
    return this.addressesService.createAddress(userId, dto);
  }

  @Patch(':id')
  async updateAddress(
    @Param('id') id: number,
    @Request() req,
    @Body() dto: UpdateAddressDto,
  ) {
    const userId = req.user.id;
    return this.addressesService.updateAddress(id, userId, dto);
  }

  @Delete(':id')
  async deleteAddress(@Param('id') id: number, @Request() req) {
    const userId = req.user.id;
    await this.addressesService.deleteAddress(id, userId);
    return { message: 'آدرس با موفقیت حذف شد' };
  }

  @Patch(':id/default')
  async setDefaultAddress(@Param('id') id: number, @Request() req) {
    const userId = req.user.id;
    return this.addressesService.setDefaultAddress(userId, id);
  }
}
