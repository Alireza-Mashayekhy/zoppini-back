import 'dotenv/config';

import { BlogBlock } from 'src/blog/entities/blog-block.entity';
import { BlogPost } from 'src/blog/entities/blog-post.entity';
import { DataSource } from 'typeorm';

import defaultDataSource from './typeorm-datasource';

/**
 * همان پایگاه داده‌ی اصلی، اما فقط با موجودیت‌های مربوط به وبلاگ.
 *
 * این DataSource مخصوص اسکریپتِ بازنویسی لینک‌های متن مقالات است (الگوبرداری
 * از `typeorm-care-title-datasource.ts`). هیچ migrationای اجرا نمی‌شود و
 * `synchronize` خاموش است تا اسکریپت نتواند ساختار دیتابیس را تغییر دهد.
 */
export default new DataSource({
  ...defaultDataSource.options,
  entities: [BlogPost, BlogBlock],
  migrations: [],
  migrationsRun: false,
  synchronize: false,
});
