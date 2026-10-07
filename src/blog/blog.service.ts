import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  applySearch,
  applySort,
  getPagination,
  QueryDto,
} from 'src/common/query';
import { FilesService } from 'src/files/files.service';
import { Product } from 'src/products/entities/product.entity';
import { In, Repository } from 'typeorm';

import { CreateBlogPostDto } from './dto/create-blog-post.dto';
import { SaveBlogBlocksDto } from './dto/save-blog-blocks.dto';
import { UpdateBlogPostDto } from './dto/update-blog-post.dto';
import { BlogBlock, BlogBlockType } from './entities/blog-block.entity';
import { BlogPost } from './entities/blog-post.entity';
import {
  HydratableBlock,
  hydrateBlocksWithProducts,
  normalizeBlocksPayload,
  ProductLike,
} from './utils/blog-blocks.util';
import {
  hasEditorBlocks,
  resolveBlocksFromContent,
} from './utils/blog-content.util';

@Injectable()
export class BlogService {
  constructor(
    @InjectRepository(BlogPost)
    private blogRepository: Repository<BlogPost>,
    @InjectRepository(BlogBlock)
    private blockRepository: Repository<BlogBlock>,
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
    private readonly filesService: FilesService,
  ) {}

  async create(
    createBlogPostDto: CreateBlogPostDto,
    file?: Express.Multer.File,
  ) {
    let coverImage = '';

    if (file) {
      const result = this.filesService.saveFile(file);
      coverImage = result.filename;
    }

    const isPublished = createBlogPostDto.isPublished === true;

    const post = this.blogRepository.create({
      ...createBlogPostDto,
      coverImage,
      isPublished,
      publishedAt: isPublished ? new Date() : null,
    });

    return await this.blogRepository.save(post);
  }

  async findAll(query: QueryDto, options?: { publishedOnly?: boolean }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const qb = this.blogRepository
      .createQueryBuilder('post')
      .leftJoinAndSelect('post.author', 'author');

    applySearch(qb, query.search, ['post.title', 'post.slug', 'post.excerpt']);

    applySort(qb, query.sort);

    if (options?.publishedOnly) {
      qb.andWhere('post.isPublished = :isPublished', { isPublished: true });
    }

    if (query['isFeatured'] !== undefined) {
      const isFeatured =
        query['isFeatured'] === 'true' || query['isFeatured'] === true;
      qb.andWhere('post.isFeatured = :isFeatured', { isFeatured });
    }

    const isAll = query['all'] === 'true' || query['all'] === true;

    let data, total;
    if (isAll) {
      data = await qb.getMany();
      total = data.length;
    } else {
      const { skip, take } = getPagination(page, limit);
      qb.skip(skip).take(take);
      const [result, count] = await qb.getManyAndCount();
      data = result;
      total = count;
    }

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: number, options?: { withBlocks?: boolean }) {
    const post = await this.blogRepository.findOne({
      where: { id },
      relations: { author: true },
    });

    if (!post) throw new NotFoundException('مقاله یافت نشد');

    if (options?.withBlocks) {
      post.blocks = await this.resolveBlocks(post);
    }

    return post;
  }

  async findOneBySlug(
    slug: string,
    options?: { publishedOnly?: boolean; withBlocks?: boolean },
  ) {
    const qb = this.blogRepository
      .createQueryBuilder('post')
      .leftJoinAndSelect('post.author', 'author')
      .where('post.slug = :slug', { slug });

    if (options?.publishedOnly) {
      qb.andWhere('post.isPublished = :isPublished', { isPublished: true });
    }

    const post = await qb.getOne();

    if (!post) throw new NotFoundException('مقاله یافت نشد');

    if (options?.withBlocks) {
      post.blocks = await this.resolveBlocks(post);
    }

    return post;
  }

  // ───────────────────────── بخش‌های مقاله (بلوک‌ها) ─────────────────────────

  /**
   * بخش‌های نمایشی یک مقاله.
   *
   * منبع اصلی، خود HTML مقاله است: ادیتور یکپارچه اسلایدر/گالری/FAQ/فهرست
   * را به‌شکل `<div data-zp-block>` داخل content ذخیره می‌کند و اینجا به
   * همان ساختار بخش‌ها ترجمه می‌شود تا ترتیب دقیقاً همان چیزی باشد که
   * ادمین چیده است.
   *
   * مقاله‌های قدیمی که این نشانه را ندارند، مثل قبل از جدول blog_blocks
   * خوانده می‌شوند (بدون نیاز به اسکریپت مهاجرت).
   */
  private async resolveBlocks(post: BlogPost): Promise<BlogBlock[]> {
    if (!hasEditorBlocks(post.content)) {
      return this.getBlocks(post.id);
    }

    const blocks = resolveBlocksFromContent(post.content) as HydratableBlock[];
    const products = await this.loadSliderProducts(blocks);

    return hydrateBlocksWithProducts(
      blocks,
      products,
    ) as unknown as BlogBlock[];
  }

  /** بلوک‌های مقاله به ترتیب نمایش، با اطلاعات محصول برای اسلایدرها */
  async getBlocks(postId: number): Promise<BlogBlock[]> {
    const blocks = await this.blockRepository.find({
      where: { postId },
      order: { order: 'ASC', id: 'ASC' },
    });

    const products = await this.loadSliderProducts(blocks);

    return hydrateBlocksWithProducts(blocks, products);
  }

  /**
   * ذخیره‌ی کل بخش‌های مقاله.
   *
   * چون ترتیب نمایش کاملاً در پنل ادمین (درگ‌دراپ) تعیین می‌شود، هر بار
   * کل لیست جایگزین می‌شود؛ هم atomically ساده‌تر است و هم امکان جاماندن
   * بلوک حذف‌شده را از بین می‌برد.
   */
  async saveBlocks(
    postId: number,
    dto: SaveBlogBlocksDto,
  ): Promise<BlogBlock[]> {
    await this.findOne(postId);

    const normalized = normalizeBlocksPayload(dto?.blocks ?? []);

    await this.blockRepository.manager.transaction(async manager => {
      await manager.delete(BlogBlock, { postId });

      const rows = normalized.map(block =>
        manager.create(BlogBlock, {
          postId,
          type: block.type,
          order: block.order,
          title: block.title,
          settings: block.settings,
          items: block.items.length > 0 ? block.items : null,
        }),
      );

      if (rows.length > 0) {
        await manager.save(rows);
      }
    });

    return this.getBlocks(postId);
  }

  /**
   * بارگذاری محصولات ارجاع‌شده در اسلایدرها (یک کوئری برای همه)
   */
  private async loadSliderProducts(
    blocks: HydratableBlock[],
  ): Promise<Map<number, ProductLike>> {
    const ids = new Set<number>();

    for (const block of blocks) {
      if (block.type !== BlogBlockType.Slider) continue;

      for (const item of block.items ?? []) {
        if (typeof item.productId === 'number') ids.add(item.productId);
      }
    }

    if (ids.size === 0) return new Map();

    const products = await this.productRepository.find({
      where: { id: In([...ids]) },
      relations: {
        variants: { color: true },
        colorImages: { color: true },
      },
    });

    return new Map(products.map(product => [product.id, product]));
  }

  async update(
    id: number,
    updateBlogPostDto: UpdateBlogPostDto,
    file?: Express.Multer.File,
  ) {
    const post = await this.blogRepository.findOne({ where: { id } });

    if (!post) throw new NotFoundException('مقاله یافت نشد');

    if (file) {
      const result = this.filesService.saveFile(file);
      post.coverImage = result.filename;
    }

    const wasPublished = post.isPublished;
    Object.assign(post, updateBlogPostDto);

    if (post.isPublished && !wasPublished) {
      post.publishedAt = new Date();
    }

    if (!post.isPublished) {
      post.publishedAt = null;
    }

    return this.blogRepository.save(post);
  }

  async remove(id: number) {
    const post = await this.blogRepository.findOne({ where: { id } });

    if (!post) throw new NotFoundException('مقاله یافت نشد');

    return this.blogRepository.delete(id);
  }
}
