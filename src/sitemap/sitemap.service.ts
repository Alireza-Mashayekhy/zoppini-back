import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { BlogPost } from 'src/blog/entities/blog-post.entity';
import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import { SeoService } from 'src/seo/seo.service';
import { Repository } from 'typeorm';

import { SitemapItemDto } from './dto/sitemap-item.dto';

/**
 * تبدیل امنِ زمان به رشته‌ی ISO.
 *
 * کوئریِ raw محصولات مقدارِ ستون را به‌شکل رشته برمی‌گرداند و موجودیت‌ها به‌شکل
 * `Date`؛ این تابع هر دو حالت را یکسان می‌کند تا `updatedAt` همیشه یا ISO
 * معتبر باشد یا `null` (هیچ‌وقت مقدارِ نامعتبر یا زمانِ جعلی).
 */
function toIsoStringOrNull(value: unknown): string | null {
  if (!value) return null;

  // کوئریِ raw مقدار را به‌شکل رشته برمی‌گرداند و موجودیت‌ها به‌شکل `Date`؛
  // هر دو حالت اینجا یکسان می‌شود. تبدیلِ ابجکت به رشته (`String(value)`)
  // عمداً انجام نمی‌شود چون `[object Object]` می‌سازد و تاریخِ نامعتبر است.
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;

  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

@Injectable()
export class SitemapService {
  constructor(
    @InjectRepository(Category)
    private categoryRepo: Repository<Category>,
    @InjectRepository(Product)
    private productRepo: Repository<Product>,
    @InjectRepository(BlogPost)
    private blogRepo: Repository<BlogPost>,
    private seoService: SeoService,
  ) {}

  async getSitemapData(): Promise<{
    categories: SitemapItemDto[];
    products: SitemapItemDto[];
    blogPosts: SitemapItemDto[];
  }> {
    // مسیرهایی که در پنل سئو، noindex یا ریدایرکت 301 گرفته‌اند
    // نباید در نقشه‌ی سایت بیایند.
    const excludedPaths = new Set(await this.seoService.getExcludedPaths());

    const categories = await this.categoryRepo.find({
      select: { name: true, slug: true, updatedAt: true },
      where: { isActive: true },
    });

    /**
     * فهرست محصولاتِ نقشه‌ی سایت.
     *
     * سیاست: **موجودی (stock) معیارِ حذف نیست.**
     *
     * - صفحه‌ی محصولِ ناموجود همچنان با وضعیت ۲۰۰، محتوای کامل، canonicalِ
     *   معتبر و `availability: OutOfStock` در داده‌ی ساختاریافته منتشر
     *   می‌شود؛ بنابراین یک صفحه‌ی زنده و ایندکس‌شدنی است.
     * - موجودی هر شب از طریق همگام‌سازی ERP (Rahkaran) تغییر می‌کند؛ حذفِ
     *   محصولاتِ ناموجود باعث می‌شد آن‌ها هر شب از نقشه‌ی سایت خارج و دوباره
     *   برگردند (نوسانِ بی‌دلیل در پوششِ Search Console).
     * - نقشه‌ی سایت ابزارِ «کشف» است نه «عدم ایندکس»؛ برای خارج کردنِ یک
     *   محصول از ایندکس باید `indexable = 0` ست شود (که اینجا رعایت می‌شود)
     *   یا محصول حذف شود.
     *
     * فیلترهای باقی‌مانده:
     * - `product.indexable = 1` → محصولات noindex حذف می‌شوند؛
     * - محصولات حذف‌شده اصلاً در جدول نیستند، پس طبیعتاً حذف‌اند؛
     * - مسیرهای noindex/ریدایرکت‌شده در پنل سئو در مرحله‌ی بعد فیلتر می‌شوند.
     *
     * توجه: `updatedAt` فقط با ویرایشِ واقعی محصول تغییر می‌کند (همگام‌سازی
     * شبانه فقط `variant` را ذخیره می‌کند)، بنابراین موجودی روی `<lastmod>`
     * اثر نمی‌گذارد و تاریخِ جعلی تولید نمی‌شود.
     */
    const products = await this.productRepo
      .createQueryBuilder('product')
      .select('product.title', 'title')
      .addSelect('product.slug', 'slug')
      // زمان واقعیِ تغییر محصول برای <lastmod>؛ بدون آن فرانت‌اند زمان
      // معتبری ندارد و تگ حذف می‌شود (جایگزینی با زمان درخواست ممنوع).
      .addSelect('product.updatedAt', 'updatedAt')
      // محصولات noindex شده در پنل محصول، در نقشه‌ی سایت نمی‌آیند
      .where('product.indexable = 1')
      .getRawMany<{ title: string; slug: string; updatedAt?: Date | string }>();

    const blogPosts = await this.blogRepo.find({
      select: { title: true, slug: true, updatedAt: true },
      // مقاله‌های منتشرشده و ایندکس‌شونده در نقشه‌ی سایت می‌آیند
      where: { isPublished: true, indexable: true },
    });

    return {
      categories: categories
        .filter(c => !excludedPaths.has(`/product-category/${c.slug}`))
        .map(c => ({
          name: c.name,
          slug: c.slug,
          updatedAt: toIsoStringOrNull(c.updatedAt),
        })),
      products: products
        .filter(p => !excludedPaths.has(`/product/${p.slug}`))
        .map(p => ({
          name: p.title,
          slug: p.slug,
          updatedAt: toIsoStringOrNull(p.updatedAt),
        })),
      blogPosts: blogPosts
        .filter(b => !excludedPaths.has(`/blog/${b.slug}`))
        .map(b => ({
          name: b.title,
          slug: b.slug,
          updatedAt: toIsoStringOrNull(b.updatedAt),
        })),
    };
  }
}
