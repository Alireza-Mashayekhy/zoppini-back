import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { applySearch, getPagination, QueryDto } from 'src/common/query';
import { Repository } from 'typeorm';

import { CreateVisitDto } from './dto/create-visit.dto';
import { Visit } from './entities/visit.entity';

interface VisitRequestContext {
  ip: string | null;
  guestId: string | null;
  userId: number | null;
}

@Injectable()
export class VisitsService {
  private readonly logger = new Logger(VisitsService.name);

  constructor(
    @InjectRepository(Visit)
    private readonly visitRepo: Repository<Visit>,
  ) {}

  // =========================================================
  // CREATE - PUBLIC (فراخوانی از لندینگ/گیمیفیکیشن)
  // =========================================================

  async track(dto: CreateVisitDto, request: Request) {
    const context = this.extractRequestContext(request);

    const visit = this.visitRepo.create({
      page: dto.page,
      path: dto.path?.slice(0, 500),
      referrer: dto.referrer?.slice(0, 500),
      userAgent: this.resolveUserAgent(dto.userAgent, request),
      deviceType: dto.deviceType,
      os: dto.os,
      browser: dto.browser,
      screen: dto.screen,
      language: dto.language,
      utmSource: dto.utmSource,
      utmMedium: dto.utmMedium,
      utmCampaign: dto.utmCampaign,
      ...context,
    });

    try {
      await this.visitRepo.save(visit);
    } catch (error) {
      // ثبت بازدید هرگز نباید تجربه کاربر را خراب کند
      this.logger.warn(`Failed to record visit: ${error?.message}`);
      return { message: 'visit not recorded' };
    }

    return { message: 'visit recorded' };
  }

  // =========================================================
  // FIND ALL - ADMIN
  // =========================================================

  async findAll(query: QueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.visitRepo.createQueryBuilder('visit');

    applySearch(qb, query.search, [
      'visit.ip',
      'visit.page',
      'visit.path',
      'visit.os',
      'visit.browser',
      'visit.deviceType',
      'visit.utmSource',
      'visit.utmCampaign',
    ]);

    // فیلتر بر اساس صفحه
    if (query.pageFilter) {
      qb.andWhere('visit.page = :pageFilter', {
        pageFilter: query.pageFilter,
      });
    }

    // فیلتر نوع دستگاه
    if (query.deviceType) {
      qb.andWhere('visit.deviceType = :deviceType', {
        deviceType: query.deviceType,
      });
    }

    // فیلتر بازه تاریخ (از - تا)
    if (query.from) {
      const fromDate = new Date(query.from);
      if (!Number.isNaN(fromDate.getTime())) {
        qb.andWhere('visit.createdAt >= :fromDate', { fromDate });
      }
    }

    if (query.to) {
      const toDate = new Date(query.to);
      if (!Number.isNaN(toDate.getTime())) {
        // تا انتهای روز انتخاب‌شده
        toDate.setHours(23, 59, 59, 999);
        qb.andWhere('visit.createdAt <= :toDate', { toDate });
      }
    }

    qb.orderBy('visit.createdAt', 'DESC').addOrderBy('visit.id', 'DESC');

    const { skip, take } = getPagination(page, limit);
    qb.skip(skip).take(take);

    const [data, total] = await qb.getManyAndCount();

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

  // =========================================================
  // STATS - ADMIN
  // =========================================================

  async getStats() {
    const [total, today, uniqueIps, byPage, byDevice] = await Promise.all([
      this.visitRepo.count(),
      this.visitRepo
        .createQueryBuilder('visit')
        .where('visit.createdAt >= :startOfToday', {
          startOfToday: this.getStartOfToday(),
        })
        .getCount(),
      this.visitRepo
        .createQueryBuilder('visit')
        .select('COUNT(DISTINCT visit.ip)', 'count')
        .getRawOne<{ count: string }>(),
      this.visitRepo
        .createQueryBuilder('visit')
        .select('visit.page', 'page')
        .addSelect('COUNT(visit.id)', 'count')
        .groupBy('visit.page')
        .getRawMany<{ page: string; count: string }>(),
      this.visitRepo
        .createQueryBuilder('visit')
        .select('visit.deviceType', 'deviceType')
        .addSelect('COUNT(visit.id)', 'count')
        .groupBy('visit.deviceType')
        .getRawMany<{ deviceType: string | null; count: string }>(),
    ]);

    return {
      total,
      today,
      uniqueIps: Number(uniqueIps?.count ?? 0),
      byPage: byPage.map(row => ({
        page: row.page,
        count: Number(row.count),
      })),
      byDevice: byDevice.map(row => ({
        deviceType: row.deviceType ?? 'unknown',
        count: Number(row.count),
      })),
    };
  }

  // =========================================================
  // DELETE - ADMIN
  // =========================================================

  async remove(id: number) {
    const visit = await this.visitRepo.findOne({ where: { id } });

    if (!visit) {
      return { message: 'visit not found' };
    }

    await this.visitRepo.remove(visit);

    return { message: 'visit deleted' };
  }

  // =========================================================
  // HELPERS
  // =========================================================

  /**
   * استخراج آی‌پی واقعی کاربر از هدرهای پروکسی/کلودفلر
   * و شناسه مهمان از کوکی guestId.
   */
  private extractRequestContext(request: Request): VisitRequestContext {
    const headerGuestId = request.headers['x-guest-id'];

    return {
      ip: this.extractIp(request),
      guestId:
        (typeof headerGuestId === 'string' && headerGuestId
          ? headerGuestId
          : null) ??
        (request as any).cookies?.guestId ??
        null,
      userId: (request as any).user?.id ?? null,
    };
  }

  private extractIp(request: Request): string | null {
    const headers = request.headers;

    // آخرین عضو X-Forwarded-For = آی‌پی واقعی که آخرین پروکسی دیده است
    // (اعضای اول لیست را کلاینت می‌تواند جعل کند)
    const xff =
      typeof headers['x-forwarded-for'] === 'string'
        ? headers['x-forwarded-for']
            .split(',')
            .map(part => part.trim())
            .filter(Boolean)
            .pop()
        : undefined;

    const candidates = [
      headers['cf-connecting-ip'], // Cloudflare
      headers['ar-real-ip'], // ArvanCloud
      headers['x-real-ip'],
      xff,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate.slice(0, 45);
      }
    }

    return request.ip ?? null;
  }

  private getStartOfToday(): Date {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
  }

  /**
   * اولویت با User-Agent واقعی هدر درخواست است؛
   * مقدار ارسالی کلاینت فقط وقتی استفاده می‌شود که هدر در دسترس نباشد.
   */
  private resolveUserAgent(
    dtoUserAgent: string | undefined,
    request: Request,
  ): string | null {
    const headerUa = request.headers['user-agent'];

    if (typeof headerUa === 'string' && headerUa.length > 0) {
      return headerUa.slice(0, 500);
    }

    return dtoUserAgent ?? null;
  }
}
