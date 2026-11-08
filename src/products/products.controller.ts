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
    @Query('directCategory') directCategory?: string,
  ) {
    const filters = {
      categoryIds: categoryIds ? categoryIds.split(',').map(Number) : undefined,
      colorIds: colorIds ? colorIds.split(',').map(Number) : undefined,
      sizeIds: sizeIds ? sizeIds.split(',').map(Number) : undefined,
      directCategory: directCategory === 'true',
    };

    return this.productsService.findAll(query, filters, {
      onlyInStock: true,
    });
  }

  @Get('/color')
  allColors() {
    return this.productsService.allColors();
  }

  @Get('/size')
  allSizes() {
    return this.productsService.allSizes();
  }

  @Get('/discounted')
  findDiscounted(@Query() query: QueryDto) {
    return this.productsService.getDiscountedProducts(query, {
      onlyInStock: true,
    });
  }

  // Keep the static route before ':slug'; otherwise Express/Nest can treat
  // "search-suggestions" as a product slug and respond with a misleading 404.
  @Get('/search-suggestions')
  searchSuggestions(@Query() query: QueryDto) {
    return this.productsService.getSearchSuggestions(query.search, query.limit);
  }

  @Get(':slug')
  findOne(@Param('slug') slug: string) {
    return this.productsService.findOne(slug, {
      onlyInStock: true,
    });
  }
}
