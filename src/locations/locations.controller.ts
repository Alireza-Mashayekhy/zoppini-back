// src/locations/locations.controller.ts
import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';

import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enum/role.enum';
import { RolesGuard } from '../common/guards/roles.guard';
import { LocationsService } from './locations.service';

@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get('provinces')
  async getProvinces() {
    return this.locationsService.findAllProvinces();
  }

  @Get('provinces/:id')
  async getProvinceById(@Param('id', ParseIntPipe) id: number) {
    return this.locationsService.findProvinceById(id);
  }

  @Get('provinces/:provinceId/cities')
  async getCitiesByProvince(
    @Param('provinceId', ParseIntPipe) provinceId: number,
  ) {
    return this.locationsService.findCitiesByProvince(provinceId);
  }

  @Get('cities/search')
  async searchCities(@Query('q') query: string) {
    if (!query || query.length < 2) return [];
    return this.locationsService.searchCities(query);
  }

  // مسیر پاک کردن کش (فقط ادمین)
  @Delete('cache')
  @UseGuards(RolesGuard)
  @Roles(Role.Admin)
  async clearCache() {
    await this.locationsService.clearAllCache();
    return { message: 'کش با موفقیت پاک شد.' };
  }
}
