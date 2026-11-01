import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * تصویر یک جایگاه از صفحه اصلی سایت که مدیر از پنل آپلود کرده است.
 *
 * هر رکورد نماینده‌ی یک جایگاه است (مثل بنر فروش ویژه) و کلید آن (`slot`)
 * یکتاست. اگر برای جایگاهی رکوردی وجود نداشته باشد، فرانت‌اند تصویر
 * پیش‌فرض خودش را نمایش می‌دهد.
 *
 * `desktopImage` و `mobileImage` فقط «نام فایل» ذخیره‌شده در پوشه‌ی uploads
 * هستند (مثل `a1b2c3.webp`) تا دامنه‌ی سرو فایل‌ها بین محیط‌ها قابل تغییر باشد.
 */
@Entity('site_images')
export class SiteImage {
  @PrimaryGeneratedColumn()
  id: number;

  /** کلید جایگاه؛ یکی از مقادیر `SITE_IMAGE_SLOT_KEYS` */
  @Column({ type: 'varchar', length: 100, unique: true })
  slot: string;

  /** نام فایل تصویر دسکتاپ (نسبی، داخل پوشه‌ی uploads) */
  @Column({
    name: 'desktop_image',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  desktopImage: string | null;

  /**
   * نام فایل تصویر موبایل — اختیاری.
   *
   * اگر خالی باشد، همان تصویر دسکتاپ روی موبایل هم استفاده می‌شود.
   */
  @Column({
    name: 'mobile_image',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  mobileImage: string | null;

  /** متن جایگزین (alt) تصویر؛ برای سئو و دسترس‌پذیری */
  @Column({ type: 'varchar', length: 255, nullable: true })
  alt: string | null;

  /** لینک کلیک روی تصویر (فقط برای جایگاه‌هایی که لینک دارند) */
  @Column({ name: 'link_url', type: 'varchar', length: 2048, nullable: true })
  linkUrl: string | null;

  /**
   * آیا تصویر آپلودشده روی سایت نمایش داده شود؟
   *
   * با خاموش‌کردن آن، آپلود حذف نمی‌شود و فقط تصویر پیش‌فرض سایت برمی‌گردد.
   */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
