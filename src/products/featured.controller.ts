// src/featured/featured.controller.ts
import { Controller, Get, Param } from '@nestjs/common';

import { FeaturedService } from './featured.service';

@Controller('featured')
export class FeaturedController {
  constructor(private readonly featuredService: FeaturedService) {}

  @Get()
  async getFeaturedProducts() {
    return this.featuredService.getFeaturedProducts({
      onlyInStock: true,
    });
  }

  @Get(':id')
  async getFeaturedProduct(@Param('id') id: number) {
    return this.featuredService.getFeaturedProduct(id, {
      onlyInStock: true,
    });
  }
}
