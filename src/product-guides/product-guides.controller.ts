import { Controller, Get, Param } from '@nestjs/common';

import { ProductGuidesService } from './product-guides.service';

@Controller('product-guides')
export class ProductGuidesController {
  constructor(private readonly productGuidesService: ProductGuidesService) {}

  @Get('product/:productId')
  getByProductId(@Param('productId') productId: string) {
    return this.productGuidesService.getPublicGuidesByProductId(+productId);
  }

  @Get('product-slug/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.productGuidesService.getPublicGuidesByProductSlug(slug);
  }
}
