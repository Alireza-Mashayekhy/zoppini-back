import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlogPost } from 'src/blog/entities/blog-post.entity';
import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import { SeoModule } from 'src/seo/seo.module';

import { SitemapController } from './sitemap.controller';
import { SitemapService } from './sitemap.service';

@Module({
  imports: [TypeOrmModule.forFeature([Category, Product, BlogPost]), SeoModule],
  controllers: [SitemapController],
  providers: [SitemapService],
})
export class SitemapModule {}
