import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  applySearch,
  applySort,
  getPagination,
  QueryDto,
} from 'src/common/query';
import { Repository } from 'typeorm';

import { CreatePageSeoDto, normalizeSeoPath } from './dto/create-page-seo.dto';
import { UpdatePageSeoDto } from './dto/update-page-seo.dto';
import { PageSeo } from './entities/page-seo.entity';
import { DEFAULT_PAGES_SEO } from './seo.constants';

@Injectable()
export class SeoService implements OnModuleInit {
  private readonly logger = new Logger(SeoService.name);

  constructor(
    @InjectRepository(PageSeo)
    private readonly pageSeoRepository: Repository<PageSeo>,
  ) {}

  /**
   * در اولین بالا آمدن سرور، صفحات پیش‌فرض سایت را در دیتابیس می‌سازد
   * تا مدیر سئو از همان ابتدا لیست کامل صفحات را ببیند.
   */
  async onModuleInit() {
    try {
      const existing = await this.pageSeoRepository.find({
        select: { path: true },
      });

      const existingPaths = new Set(existing.map(item => item.path));

      const missing = DEFAULT_PAGES_SEO.filter(
        page => !existingPaths.has(page.path),
      );

      if (!missing.length) return;

      await this.pageSeoRepository.save(this.pageSeoRepository.create(missing));

      this.logger.log(`✅ ${missing.length} صفحه‌ی پیش‌فرض سئو اضافه شد`);
    } catch (error) {
      this.logger.warn(
        `افزودن صفحات پیش‌فرض سئو انجام نشد: ${(error as Error).message}`,
      );
    }
  }

  /** لیست صفحات سئو برای پنل مدیریت (با جست‌وجو و صفحه‌بندی) */
  async findAll(query: QueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.pageSeoRepository.createQueryBuilder('page');

    applySearch(qb, query.search, [
      'page.label',
      'page.path',
      'page.metaTitle',
      'page.metaDescription',
    ]);

    if (query.sort) {
      applySort(qb, query.sort);
    } else {
      qb.orderBy('page.id', 'ASC');
    }

    const isAll = query['all'] === 'true' || query['all'] === true;

    let data: PageSeo[];
    let total: number;

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
    const pageSeo = await this.pageSeoRepository.findOne({ where: { id } });

    if (!pageSeo) throw new NotFoundException('صفحه یافت نشد');

    return pageSeo;
  }

  /**
   * متای یک صفحه بر اساس مسیر آن.
   * اگر برای آن مسیر متایی ثبت نشده باشد `null` برمی‌گرداند تا فرانت‌اند
   * از متادیتای پیش‌فرض خود صفحه استفاده کند.
   */
  async findByPath(path: string) {
    const normalized = normalizeSeoPath(path);

    if (typeof normalized !== 'string' || !normalized) return null;

    return this.pageSeoRepository.findOne({ where: { path: normalized } });
  }

  async create(createPageSeoDto: CreatePageSeoDto) {
    const path = normalizeSeoPath(createPageSeoDto.path) as string;

    await this.ensurePathIsFree(path);

    const pageSeo = this.pageSeoRepository.create({
      ...createPageSeoDto,
      path,
      metaTitle: createPageSeoDto.metaTitle ?? '',
      metaDescription: createPageSeoDto.metaDescription ?? '',
    });

    return this.pageSeoRepository.save(pageSeo);
  }

  async update(id: number, updatePageSeoDto: UpdatePageSeoDto) {
    const pageSeo = await this.findOne(id);

    if (updatePageSeoDto.path !== undefined) {
      const path = normalizeSeoPath(updatePageSeoDto.path) as string;

      if (path !== pageSeo.path) {
        await this.ensurePathIsFree(path);
        pageSeo.path = path;
      }
    }

    if (updatePageSeoDto.label !== undefined) {
      pageSeo.label = updatePageSeoDto.label;
    }

    if (updatePageSeoDto.metaTitle !== undefined) {
      pageSeo.metaTitle = updatePageSeoDto.metaTitle;
    }

    if (updatePageSeoDto.metaDescription !== undefined) {
      pageSeo.metaDescription = updatePageSeoDto.metaDescription;
    }

    return this.pageSeoRepository.save(pageSeo);
  }

  async remove(id: number) {
    const pageSeo = await this.findOne(id);

    await this.pageSeoRepository.remove(pageSeo);

    return { ...pageSeo, id };
  }

  private async ensurePathIsFree(path: string) {
    const existing = await this.pageSeoRepository.findOne({ where: { path } });

    if (existing) {
      throw new ConflictException('برای این مسیر قبلاً متا ثبت شده است');
    }
  }
}
