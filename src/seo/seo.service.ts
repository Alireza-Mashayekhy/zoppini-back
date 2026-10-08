import {
  BadRequestException,
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
import { IsNull, Not, Repository } from 'typeorm';

import {
  CreatePageSeoDto,
  normalizeSeoPath,
  normalizeSeoTarget,
} from './dto/create-page-seo.dto';
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
      'page.redirectTo',
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

  /**
   * مقصد ریدایرکت 301 برای یک مسیر.
   * اگر ریدایرکتی ثبت نشده باشد `null` برمی‌گرداند.
   * فرانت‌اند (proxy/middleware) با این اندپوینت مسیرها را به‌صورت 301
   * به مقصد منتقل می‌کند.
   */
  async findRedirectByPath(path: string) {
    const normalized = normalizeSeoPath(path);

    if (typeof normalized !== 'string' || !normalized) return null;

    const pageSeo = await this.pageSeoRepository.findOne({
      where: { path: normalized, redirectTo: Not(IsNull()) },
    });

    if (!pageSeo?.redirectTo) return null;

    return {
      path: pageSeo.path,
      redirectTo: pageSeo.redirectTo,
    };
  }

  /**
   * همه‌ی ریدایرکت‌های 301 ثبت‌شده در پنل.
   * فرانت‌اند این لیست را می‌گیرد و در proxy خود به‌صورت یک نقشه
   * (path → مقصد) کش می‌کند تا هر بازدید، نیازی به درخواست جداگانه
   * به بک‌اند نداشته باشد.
   */
  async findAllRedirects() {
    const redirects = await this.pageSeoRepository.find({
      select: { id: true, path: true, label: true, redirectTo: true },
      where: { redirectTo: Not(IsNull()) },
      order: { id: 'ASC' },
    });

    return redirects.filter(item => !!item.redirectTo);
  }

  /**
   * مسیرهایی که نباید در نقشه‌ی سایت (sitemap) بیایند:
   * صفحاتی که `noindex` هستند یا ریدایرکت 301 دارند.
   */
  async getExcludedPaths() {
    const rows = await this.pageSeoRepository.find({
      select: { path: true },
      where: [{ indexable: false }, { redirectTo: Not(IsNull()) }],
    });

    return rows.map(row => row.path);
  }

  async create(createPageSeoDto: CreatePageSeoDto) {
    const path = normalizeSeoPath(createPageSeoDto.path) as string;

    await this.ensurePathIsFree(path);

    const redirectTo = normalizeSeoTarget(createPageSeoDto.redirectTo) as
      string | null;

    await this.ensureNoRedirectLoop(path, redirectTo);

    const pageSeo = this.pageSeoRepository.create({
      ...createPageSeoDto,
      path,
      metaTitle: createPageSeoDto.metaTitle ?? '',
      metaDescription: createPageSeoDto.metaDescription ?? '',
      indexable: createPageSeoDto.indexable ?? true,
      followable: createPageSeoDto.followable ?? true,
      redirectTo,
      includeInPageSitemap: createPageSeoDto.includeInPageSitemap ?? false,
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

    if (updatePageSeoDto.indexable !== undefined) {
      pageSeo.indexable = updatePageSeoDto.indexable;
    }

    if (updatePageSeoDto.followable !== undefined) {
      pageSeo.followable = updatePageSeoDto.followable;
    }

    if (updatePageSeoDto.includeInPageSitemap !== undefined) {
      pageSeo.includeInPageSitemap = updatePageSeoDto.includeInPageSitemap;
    }

    if (updatePageSeoDto.redirectTo !== undefined) {
      const redirectTo = normalizeSeoTarget(updatePageSeoDto.redirectTo) as
        string | null;

      await this.ensureNoRedirectLoop(pageSeo.path, redirectTo);

      pageSeo.redirectTo = redirectTo;
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

  /**
   * حلقه‌های مستقیم و چندمرحله‌ای ریدایرکت داخلی را پیش از ذخیره رد می‌کند.
   * برای آدرس کامل، فقط لینک‌هایی که به دامنه‌ی اصلی سایت برمی‌گردند
   * به‌عنوان مسیر داخلی بررسی می‌شوند.
   */
  private async ensureNoRedirectLoop(
    path: string,
    redirectTo: string | null,
  ): Promise<void> {
    if (!redirectTo) return;

    const normalizedPath = normalizeSeoPath(path) as string;
    const firstTarget = this.getInternalRedirectPath(redirectTo);

    if (!firstTarget) return;

    const redirects = await this.pageSeoRepository.find({
      select: { path: true, redirectTo: true },
      where: { redirectTo: Not(IsNull()) },
    });
    const redirectMap = new Map(
      redirects
        .filter(item => item.redirectTo)
        .map(item => [item.path, item.redirectTo as string]),
    );

    // در زمان update، مقدار مقصد جدید فعلی را برای بررسی زنجیره لحاظ می‌کنیم.
    redirectMap.set(normalizedPath, redirectTo);

    const visited = new Set<string>([normalizedPath]);
    let targetPath: string | null = firstTarget;

    while (targetPath) {
      if (visited.has(targetPath)) {
        throw new BadRequestException(
          'این مقصد باعث ایجاد حلقه‌ی ریدایرکت می‌شود',
        );
      }

      visited.add(targetPath);
      const nextTarget = redirectMap.get(targetPath);
      targetPath = nextTarget ? this.getInternalRedirectPath(nextTarget) : null;
    }
  }

  /** مقصد داخلی را از مسیر نسبی یا URL متعلق به سایت استخراج می‌کند. */
  private getInternalRedirectPath(target: string): string | null {
    if (target.startsWith('/')) {
      return normalizeSeoPath(target) as string;
    }

    try {
      const targetUrl = new URL(target);
      const siteUrl = new URL(
        process.env.NEXT_PUBLIC_SITE_URL ||
          process.env.FRONTEND_URL ||
          'https://zoppinico.com',
      );

      if (targetUrl.origin !== siteUrl.origin) return null;

      return normalizeSeoPath(targetUrl.pathname) as string;
    } catch {
      return null;
    }
  }
}
