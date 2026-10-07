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
  @Column({ length: 255, nullable: true })
  label: string | null;

  /** متا تایتل صفحه؛ اگر خالی باشد، عنوان پیش‌فرض خود صفحه استفاده می‌شود */
  @Column({ length: 255, nullable: true })
  metaTitle: string | null;

  /** متا دیسکریپشن صفحه؛ اگر خالی باشد، توضیحات پیش‌فرض خود صفحه استفاده می‌شود */
  @Column({ type: 'text', nullable: true })
  metaDescription: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
