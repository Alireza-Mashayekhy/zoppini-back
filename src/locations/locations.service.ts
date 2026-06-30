import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Cache } from 'cache-manager';
import { Repository } from 'typeorm';

import { City } from './entities/city.entity';
import { Province } from './entities/province.entity';

@Injectable()
export class LocationsService {
  constructor(
    @InjectRepository(Province)
    private provinceRepo: Repository<Province>,
    @InjectRepository(City)
    private cityRepo: Repository<City>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  // دریافت همه استان‌ها
  async findAllProvinces(): Promise<Province[]> {
    const cacheKey = 'provinces_all';
    const cached = await this.cacheManager.get<Province[]>(cacheKey);
    if (cached) return cached;

    const provinces = await this.provinceRepo.find({ order: { name: 'ASC' } });
    await this.cacheManager.set(cacheKey, provinces, 86400); // ۱ روز
    return provinces;
  }

  // دریافت یک استان با شناسه
  async findProvinceById(id: number): Promise<Province> {
    const cacheKey = `province_${id}`;
    const cached = await this.cacheManager.get<Province>(cacheKey);
    if (cached) return cached;

    const province = await this.provinceRepo.findOne({
      where: { id },
      relations: { cities: true },
    });
    if (!province) throw new NotFoundException('استان یافت نشد');
    await this.cacheManager.set(cacheKey, province, 86400);
    return province;
  }

  // دریافت شهرهای یک استان
  async findCitiesByProvince(provinceId: number): Promise<City[]> {
    const cacheKey = `cities_province_${provinceId}`;
    const cached = await this.cacheManager.get<City[]>(cacheKey);
    if (cached) return cached;

    const cities = await this.cityRepo.find({
      where: { provinceId },
      order: { name: 'ASC' },
    });
    await this.cacheManager.set(cacheKey, cities, 86400);
    return cities;
  }

  // جستجوی شهرها (بر اساس عبارت)
  async searchCities(search: string): Promise<City[]> {
    const cacheKey = `cities_search_${search}`;
    const cached = await this.cacheManager.get<City[]>(cacheKey);
    if (cached) return cached;

    const cities = await this.cityRepo
      .createQueryBuilder('city')
      .leftJoinAndSelect('city.province', 'province')
      .where('city.name LIKE :search', { search: `%${search}%` })
      .orWhere('province.name LIKE :search', { search: `%${search}%` })
      .orderBy('city.name', 'ASC')
      .limit(20)
      .getMany();

    await this.cacheManager.set(cacheKey, cities, 86400);
    return cities;
  }

  // پاک کردن تمام کش (برای مواقعی که داده‌ها تغییر می‌کنند)
  async clearAllCache(): Promise<void> {
    await this.cacheManager.clear();
  }
}
