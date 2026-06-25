import { Body, Controller, Get, Param, Query } from '@nestjs/common';
import { QueryDto } from 'src/common/query';

import { ProductsService } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll(
    @Query() query: QueryDto,
    @Query('categoryIds') categoryIds?: string,
    @Query('colorIds') colorIds?: string,
    @Query('sizeIds') sizeIds?: string,
  ) {
    const filters = {
      categoryIds: categoryIds ? categoryIds.split(',').map(Number) : undefined,
      colorIds: colorIds ? colorIds.split(',').map(Number) : undefined,
      sizeIds: sizeIds ? sizeIds.split(',').map(Number) : undefined,
    };

    return this.productsService.findAll(query, filters);
  }

  @Get('/color')
  allColors() {
    return this.productsService.allColors();
  }

  @Get('/size')
  allSizes() {
    return this.productsService.allSizes();
  }

  @Get(':slug')
  findOne(@Param('slug') slug: string) {
    return this.productsService.findOne(slug);
  }
}
