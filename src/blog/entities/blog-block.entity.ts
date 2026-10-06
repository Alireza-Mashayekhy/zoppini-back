import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { BlogPost } from './blog-post.entity';

export enum BlogBlockType {
  /** متن اصلی مقاله (محتوای ادیتور) */
  Content = 'content',
  /** سوالات متداول مخصوص همین مقاله */
  Faq = 'faq',
  /** اسلایدر محصولات ساخته‌شده از محصولات موجود */
  Slider = 'slider',
  /** گالری عکس/فیلم آپلودشده از سیستم ادمین */
  Media = 'media',
  /** فهرست مطالب (از تیترهای مقاله ساخته می‌شود) */
  Toc = 'toc',
}

export type BlogMediaType = 'image' | 'video';

/** گزینه‌های رنگ یک محصول در اسلایدر (با تصویر و قیمت همان رنگ) */
export interface BlogSliderColorOption {
  colorId: number;
  name: string;
  hexCode: string;
  image: string | null;
  price: number;
  inStock: boolean;
}

export interface BlogSliderProduct {
  id: number;
  title: string;
  slug: string;
  /** تصویر رنگ انتخاب‌شده (یا تصویر اصلی محصول) */
  image: string | null;
  /** کمترین قیمت رنگ انتخاب‌شده */
  price: number;
  inStock: boolean;
  colorOptions: BlogSliderColorOption[];
}

/**
 * هر آیتم داخل یک بلوک.
 *
 * یک ساختار مشترک برای همه‌ی نوع‌ها استفاده می‌شود تا مرتب‌سازی
 * درگ‌دراپی (چه بلوک‌ها و چه آیتم‌های داخل بلوک) با یک آرایه ساده انجام
 * شود؛ ترتیب همان ترتیب آرایه است.
 */
export interface BlogBlockItem {
  /** محتوای HTML یک بخش متن */
  html?: string;

  /** سوالات متداول */
  question?: string;
  answer?: string;

  /** گالری مدیا */
  mediaType?: BlogMediaType;
  url?: string;
  poster?: string;
  alt?: string;

  /** اسلایدر محصولات */
  productId?: number;
  colorId?: number;
  badge?: string;

  /** مشترک */
  caption?: string;
  linkUrl?: string;
  linkLabel?: string;

  /** فقط در پاسخ API پر می‌شود (اطلاعات محصول برای نمایش) */
  product?: BlogSliderProduct | null;
}

export interface BlogBlockSettings {
  title?: string;
  autoplay?: boolean;
}

@Entity('blog_blocks')
@Index(['postId', 'order'])
export class BlogBlock {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => BlogPost, post => post.blocks, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'post_id' })
  post: BlogPost;

  @Column({ name: 'post_id' })
  postId: number;

  @Column({ type: 'enum', enum: BlogBlockType })
  type: BlogBlockType;

  /** ترتیب نمایش بین بلوک‌های مقاله (از صفر) */
  @Column({ default: 0 })
  order: number;

  /** عنوان اختیاری بخش (مثلاً «سوالات متداول») */
  @Column({ length: 150, nullable: true })
  title: string | null;

  @Column({ type: 'json', nullable: true })
  settings: BlogBlockSettings | null;

  /**
   * آیتم‌های بلوک.
   *
   * برای بلوک content خالی است چون متن مقاله در خود BlogPost.content
   * نگه‌داری می‌شود (تا جستجو/سایتمپ/لیست مقالات دست‌نخورده بماند)
   * و این بلوک فقط جایگاه نمایش متن در بین بخش‌ها را مشخص می‌کند.
   */
  @Column({ type: 'json', nullable: true })
  items: BlogBlockItem[] | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
