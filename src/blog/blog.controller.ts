import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { QueryDto } from 'src/common/query';

import { BlogService } from './blog.service';

@Controller('blog')
export class BlogController {
  constructor(private readonly blogService: BlogService) {}

  @Get()
  findAll(@Query() query: QueryDto) {
    return this.blogService.findAll(query, { publishedOnly: true });
  }

  @Get('slug/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.blogService.findOneBySlug(slug, { publishedOnly: true });
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const post = await this.blogService.findOne(+id);
    if (!post.isPublished) {
      throw new NotFoundException('مقاله یافت نشد');
    }
    return post;
  }
}
