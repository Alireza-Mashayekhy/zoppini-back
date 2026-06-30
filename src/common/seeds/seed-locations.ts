// src/common/seeds/seed-locations.ts
import { DataSource } from 'typeorm';

import { City } from '../../locations/entities/city.entity';
import { Province } from '../../locations/entities/province.entity';
import citiesData from '../constants/cities.json';
import provincesData from '../constants/provinces.json';

export async function seedLocations(dataSource: DataSource) {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    // غیرفعال کردن بررسی کلید خارجی
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0;');

    // پاک کردن جداول
    await queryRunner.clearTable('cities');
    await queryRunner.clearTable('provinces');

    // فعال کردن مجدد بررسی کلید خارجی (برای مرحله‌ی درج)
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1;');

    // آماده‌سازی داده‌های استان‌ها (تبدیل tel_prefix به telPrefix)
    const provinces = provincesData.map(p => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      telPrefix: p.tel_prefix, // تطابق با نام ویژگی Entity
      location: p.location,
    }));

    const provinceRepo = dataSource.getRepository(Province);
    await provinceRepo.save(provinces);

    // آماده‌سازی داده‌های شهرها (تبدیل province_id به provinceId)
    const cities = citiesData.map(c => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      provinceId: c.province_id, // تطابق با نام ویژگی Entity
      location: c.location,
    }));

    const cityRepo = dataSource.getRepository(City);
    await cityRepo.save(cities);

    await queryRunner.commitTransaction();
    console.log(
      `✅ ${provinces.length} استان و ${cities.length} شهر در دیتابیس ذخیره شدند.`,
    );
  } catch (error) {
    await queryRunner.rollbackTransaction();
    console.error('❌ خطا در تراکنش:', error);
    throw error;
  } finally {
    await queryRunner.release();
  }
}
