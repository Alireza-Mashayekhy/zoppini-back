import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { QueryDto } from 'src/common/query';

import { CategoriesService } from './categories.service';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll(@Query() query: QueryDto) {
    return this.categoriesService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(+id);
  }

  @Get('slug/:slug')
  async findBySlug(@Param('slug') slug: string) {
    const category = await this.categoriesService.findOneBySlug(slug);
    if (!category) {
      throw new NotFoundException('دسته‌بندی یافت نشد');
    }
    return category;
  }
}
