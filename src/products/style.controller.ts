import { Controller, Get, Param } from '@nestjs/common';

import { StyleService } from './style.service';

@Controller('style')
export class StyleController {
  constructor(private readonly styleService: StyleService) {}

  @Get()
  async getStyleProducts() {
    return this.styleService.getStyleProducts({
      onlyInStock: true,
    });
  }

  @Get(':id')
  async getStyleProduct(@Param('id') id: number) {
    return this.styleService.getStyleProduct(id, {
      onlyInStock: true,
    });
  }
}
