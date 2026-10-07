import { User } from 'src/users/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { BlogBlock } from './blog-block.entity';

@Entity()
export class BlogPost {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 255 })
  title: string;

  @Column({ unique: true })
  slug: string;

  @Column({ type: 'text', nullable: true })
  excerpt: string;

  /**
   * متا تایتل سئو؛ اگر مدیر آن را پر نکرده باشد، فرانت‌اند از عنوان
   * مقاله استفاده می‌کند.
   */
  @Column({ length: 255, nullable: true })
  metaTitle: string | null;

  /**
   * متا دیسکریپشن سئو؛ اگر خالی باشد، فرانت‌اند از خلاصه‌ی مقاله
   * استفاده می‌کند.
   */
  @Column({ type: 'text', nullable: true })
  metaDescription: string | null;

  /**
   * کل محتوای مقاله به‌شکل HTML.
   *
   * از نسخه‌ی ادیتور یکپارچه به بعد، متن مقاله و همه‌ی بلوک‌های ویژه
   * (اسلایدر محصولات، گالری، سوالات متداول و فهرست مطالب) در همین یک
   * ستون ذخیره می‌شوند؛ بلوک‌ها به‌شکل
   * `<div data-zp-block="…" data-zp-config="…">` داخل HTML می‌نشینند.
   * longtext چون یک مقاله‌ی بلند با چند گالری از سقف ۶۴KB عبور می‌کند.
   */
  @Column({ type: 'longtext' })
  content: string;

  @Column({ nullable: true })
  coverImage: string;

  @Column({ default: false })
  isPublished: boolean;

  @Column({ default: false })
  isFeatured: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  publishedAt: Date | null;

  @Column({ nullable: true })
  authorId: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'authorId' })
  author: User | null;

  /**
   * بخش‌های مقاله (اسلایدر محصولات، سوالات متداول، گالری عکس/فیلم، فهرست
   * مطالب و جایگاه متن اصلی) — ترتیب نمایش با درگ‌دراپ در پنل ادمین تعیین
   * می‌شود و در ستون order ذخیره می‌گردد.
   */
  @OneToMany(() => BlogBlock, block => block.post)
  blocks: BlogBlock[];
}
