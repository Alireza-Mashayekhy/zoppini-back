import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * متادیتای سئوی هر صفحه‌ی سایت (متا تایتل و متا دیسکریپشن).
 *
 * `path` مسیر صفحه در سایت است (مثل `/about-us`) و کلید یکتای هر رکورد
 * محسوب می‌شود؛ فرانت‌اند با همین مسیر، متای صفحه را از سرور می‌خواند.
 */
@Entity()
export class PageSeo {
  @PrimaryGeneratedColumn()
  id: number;

  /** مسیر صفحه؛ همیشه با اسلش شروع می‌شود (مثل /about-us یا /) */
  @Column({ unique: true, length: 255 })
  path: string;

  /** نام نمایشی صفحه برای پنل مدیریت (مثل «درباره ما») */
  @Column({ type: 'varchar', length: 255, nullable: true })
  label: string | null;

  /** متا تایتل صفحه؛ اگر خالی باشد، عنوان پیش‌فرض خود صفحه استفاده می‌شود */
  @Column({ type: 'varchar', length: 255, nullable: true })
  metaTitle: string | null;

  /** متا دیسکریپشن صفحه؛ اگر خالی باشد، توضیحات پیش‌فرض خود صفحه استفاده می‌شود */
  @Column({ type: 'text', nullable: true })
  metaDescription: string | null;

  /**
   * آیا صفحه در نتایج جستجو ایندکس شود؟
   * `false` یعنی تگ `<meta name="robots" content="noindex">` روی صفحه می‌آید
   * و صفحه از نقشه‌ی سایت (sitemap) هم حذف می‌شود.
   */
  @Column({ type: 'boolean', default: true })
  indexable: boolean;

  /**
   * آیا خزنده‌ها لینک‌های صفحه را دنبال (follow) کنند؟
   * `false` یعنی تگ `nofollow` روی صفحه اعمال می‌شود.
   */
  @Column({ type: 'boolean', default: true })
  followable: boolean;

  /**
   * اگر مقدار داشته باشد، هر بازدید از این مسیر با ریدایرکت 301 (دائمی)
   * به این آدرس منتقل می‌شود. می‌تواند مسیر نسبی (`/products`) یا
   * آدرس کامل (`https://example.com/x`) باشد. `null` یعنی بدون ریدایرکت.
   */
  @Column({ type: 'varchar', length: 2048, nullable: true })
  redirectTo: string | null;

  /** آیا این URL دستی در page-sitemap.xml منتشر شود؟ */
  @Column({ type: 'boolean', default: false })
  includeInPageSitemap: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
