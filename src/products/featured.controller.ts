// src/featured/featured.controller.ts
import { Body, Controller, Get, Param } from '@nestjs/common';

import { FeaturedService } from './featured.service';

@Controller('featured')
export class FeaturedController {
  constructor(private readonly featuredService: FeaturedService) {}

  @Get()
  async getFeaturedProducts() {
    return this.featuredService.getFeaturedProducts();
  }

  @Get(':id')
  async getFeaturedProduct(@Param('id') id: number) {
    return this.featuredService.getFeaturedProduct(id);
  }
}
