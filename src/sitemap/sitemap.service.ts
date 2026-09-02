// src/sitemap/sitemap.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { BlogPost } from 'src/blog/entities/blog-post.entity';
import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import { Repository } from 'typeorm';

import { SitemapItemDto } from './dto/sitemap-item.dto';

@Injectable()
export class SitemapService {
  constructor(
    @InjectRepository(Category)
    private categoryRepo: Repository<Category>,
    @InjectRepository(Product)
    private productRepo: Repository<Product>,
    @InjectRepository(BlogPost)
    private blogRepo: Repository<BlogPost>,
  ) {}

  async getSitemapData(): Promise<{
    categories: SitemapItemDto[];
    products: SitemapItemDto[];
    blogPosts: SitemapItemDto[];
  }> {
    const categories = await this.categoryRepo.find({
      select: { name: true, slug: true, updatedAt: true },
      where: { isActive: true },
    });

    const products = await this.productRepo
      .createQueryBuilder('product')
      .select('product.title', 'title')
      .addSelect('product.slug', 'slug')
      // محصولاتی که در سایت قابل مشاهده‌اند (حداقل یک variant موجود)
      .where(
        `EXISTS (
          SELECT 1
          FROM variant v
          WHERE v.product_id = product.id
            AND v.stock > 0
        )`,
      )
      .getRawMany<{ title: string; slug: string }>();

    const blogPosts = await this.blogRepo.find({
      select: { title: true, slug: true, updatedAt: true },
      where: { isPublished: true },
    });

    return {
      categories: categories.map(c => ({ name: c.name, slug: c.slug })),
      products: products.map(p => ({ name: p.title, slug: p.slug })),
      blogPosts: blogPosts.map(b => ({ name: b.title, slug: b.slug })),
    };
  }
}
