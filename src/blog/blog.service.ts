import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  applySearch,
  applySort,
  getPagination,
  QueryDto,
} from 'src/common/query';
import { FilesService } from 'src/files/files.service';
import { Repository } from 'typeorm';

import { CreateBlogPostDto } from './dto/create-blog-post.dto';
import { UpdateBlogPostDto } from './dto/update-blog-post.dto';
import { BlogPost } from './entities/blog-post.entity';

@Injectable()
export class BlogService {
  constructor(
    @InjectRepository(BlogPost)
    private blogRepository: Repository<BlogPost>,
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

  async findOne(id: number) {
    const post = await this.blogRepository.findOne({
      where: { id },
      relations: { author: true },
    });

    if (!post) throw new NotFoundException('مقاله یافت نشد');

    return post;
  }

  async findOneBySlug(slug: string, options?: { publishedOnly?: boolean }) {
    const qb = this.blogRepository
      .createQueryBuilder('post')
      .leftJoinAndSelect('post.author', 'author')
      .where('post.slug = :slug', { slug });

    if (options?.publishedOnly) {
      qb.andWhere('post.isPublished = :isPublished', { isPublished: true });
    }

    const post = await qb.getOne();

    if (!post) throw new NotFoundException('مقاله یافت نشد');

    return post;
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
