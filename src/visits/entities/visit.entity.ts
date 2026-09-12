import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('visits')
export class Visit {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * آی‌پی کاربر — از هدرهای پروکسی (CF-Connecting-IP / X-Forwarded-For)
   * استخراج می‌شود و در صورت نبود آن‌ها از req.ip.
   */
  @Index()
  @Column({ type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  /**
   * شناسه مهمان (کوکی x-guest-id) — برای پیگیری کاربر در طول زمان.
   */
  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  guestId: string | null;

  /**
   * شناسه کاربر لاگین‌شده (در صورت وجود) — از توکن JWT استخراج می‌شود.
   */
  @Index()
  @Column({ type: 'int', nullable: true })
  userId: number | null;

  /**
   * صفحه‌ای که بازدیدکننده وارد آن شده است.
   * مقادیر: landing-opening | gamification
   */
  @Index()
  @Column({ type: 'varchar', length: 100 })
  page: string;

  /**
   * مسیر کامل مرورگر (path + query).
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  path: string | null;

  /**
   * مرجع ارجاع‌دهنده (document.referrer).
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  referrer: string | null;

  /**
   * User-Agent خام مرورگر.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  // ===== اطلاعات تجزیه‌شده دستگاه (سمت کلاینت جمع‌آوری و سمت سرور اعتبارسنجی می‌شود) =====

  @Column({ type: 'varchar', length: 20, nullable: true })
  deviceType: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  os: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  browser: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  screen: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  language: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  utmSource: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  utmMedium: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  utmCampaign: string | null;

  /**
   * تاریخ و ساعت ورود (به وقت UTC توسط دیتابیس).
   */
  @CreateDateColumn()
  @Index()
  createdAt: Date;
}
