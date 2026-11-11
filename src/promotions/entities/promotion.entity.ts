import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * انواع پروموشن قابل ساخت از پنل ادمین.
 *
 * هر نوع، یک استراتژی محاسبه در `promotions/engine` دارد؛ افزودن نوع جدید
 * یعنی افزودن یک enum + استراتژی + فیلدهای فرم، بدون تغییر منطق سبد/سفارش.
 */
export enum PromotionType {
  /**
   * خرید تعداد زوج از محصولات مشمول و تخفیف واحدهای ارزان‌تر
   * (پیش‌فرض: «خرید ۲، ۵۰٪ تخفیف روی ارزان‌تر»)
   */
  CHEAPER_ITEM_PAIR = 'cheaper_item_pair',

  /** خرید X، دریافت Y رایگان از همان گروه محصول */
  BUY_X_GET_Y_SAME_GROUP = 'buy_x_get_y_same_group',

  /** خرید محصول/دسته‌ی مشخص و دریافت محصولِ دیگر رایگان */
  BUY_TRIGGER_GET_REWARD = 'buy_trigger_get_reward',

  /** حداقل مبلغ خرید و دریافت درصد یا مبلغ ثابت تخفیف */
  SPEND_AND_SAVE = 'spend_and_save',

  /** خرید X کالا و دریافت درصد یا مبلغ ثابت تخفیف روی اقلام انتخابی */
  BUY_X_GET_PERCENT_OFF = 'buy_x_get_percent_off',

  /** باندل با قیمت ثابت (مثلاً ست کت و پیراهن با قیمت مشخص) */
  FIXED_PRICE_BUNDLE = 'fixed_price_bundle',

  /** ارسال رایگان بالای مبلغ مشخص یا برای دسته‌های انتخابی */
  FREE_SHIPPING = 'free_shipping',

  /** تخفیف عمومی سبد با قواعد شمول قابل تنظیم */
  CART_DISCOUNT = 'cart_discount',
}

/** نوع پاداش (تخفیف) */
export enum PromotionRewardType {
  PERCENTAGE = 'percentage',
  FIXED = 'fixed',
  FREE_ITEM = 'free_item',
  FREE_SHIPPING = 'free_shipping',
  FIXED_BUNDLE_PRICE = 'fixed_bundle_price',
}

/** دامنه‌ی شمول محصولات برای یک لیست (نوع/پاداش/استثنا) */
export enum PromotionScope {
  ALL = 'all',
  CATEGORIES = 'categories',
  PRODUCTS = 'products',
  CATEGORIES_AND_PRODUCTS = 'categories_and_products',
}

/**
 * نحوه‌ی انتخاب کالای رایگان سوم:
 * - AUTO  → سیستم خودش ارزان‌ترین کالای Eligible را هدیه می‌دهد
 * - CUSTOMER → مشتری از بین کالاهای Eligible انتخاب می‌کند
 */
export enum FreeItemSelection {
  AUTO = 'auto',
  CUSTOMER = 'customer',
}

@Entity('promotions')
export class Promotion {
  @PrimaryGeneratedColumn()
  id: number;

  /** نام نمایشی/داخلی پروموشن */
  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** توضیح داخلی برای کارمندان (به مشتری نمایش داده نمی‌شود) */
  @Column({ type: 'text', nullable: true })
  internalDescription: string | null;

  @Index()
  @Column({ type: 'enum', enum: PromotionType })
  type: PromotionType;

  // =========================================================
  // شمول محصولات
  // =========================================================

  /** دامنه‌ی اصلی محصولات/دسته‌های مشمول (محصولات محرک برای نوع C) */
  @Column({ type: 'enum', enum: PromotionScope, default: PromotionScope.ALL })
  scope: PromotionScope;

  @ManyToMany(() => Product)
  @JoinTable({
    name: 'promotion_products',
    joinColumn: { name: 'promotion_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'product_id', referencedColumnName: 'id' },
  })
  products: Product[];

  @ManyToMany(() => Category)
  @JoinTable({
    name: 'promotion_categories',
    joinColumn: { name: 'promotion_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'category_id', referencedColumnName: 'id' },
  })
  categories: Category[];

  @ManyToMany(() => Product)
  @JoinTable({
    name: 'promotion_excluded_products',
    joinColumn: { name: 'promotion_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'product_id', referencedColumnName: 'id' },
  })
  excludedProducts: Product[];

  @ManyToMany(() => Category)
  @JoinTable({
    name: 'promotion_excluded_categories',
    joinColumn: { name: 'promotion_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'category_id', referencedColumnName: 'id' },
  })
  excludedCategories: Category[];

  // =========================================================
  // پاداش
  // =========================================================

  @Column({ type: 'enum', enum: PromotionRewardType })
  rewardType: PromotionRewardType;

  /** اگر percentage باشد: 20 یعنی ۲۰٪؛ اگر fixed باشد: مبلغ به تومان */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  rewardValue: number | null;

  /** سقف تخفیف برای پاداش درصدی */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  maxDiscountAmount: number | null;

  // =========================================================
  // حداقل‌های احراز شرط
  // =========================================================

  /** حداقل تعداد واحد مشمول (برای انواع تعداد-محور) */
  @Column({ type: 'int', default: 0 })
  minQuantity: number;

  /** حداقل مبلغ سبد (تومان)؛ 0 یعنی بدون شرط */
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  minCartValue: number;

  // =========================================================
  // نوع A: خرید زوج و تخفیف ارزان‌تر
  // =========================================================

  /** تعداد واحدهای هر «گروه» که یک واحد تخفیف می‌گیرد (پیش‌فرض ۲) */
  @Column({ type: 'int', default: 2 })
  pairSize: number;

  /** اگر 1 باشد هر واحد اضافه هم تخفیف می‌گیرد؛ پیش‌فرض فقط زوج کامل */
  @Column({ type: 'boolean', default: false })
  discountEveryExtraUnit: boolean;

  // =========================================================
  // نوع B: خرید X دریافت Y از همان گروه
  // =========================================================

  @Column({ type: 'int', default: 0 })
  requiredQuantity: number;

  @Column({ type: 'int', default: 0 })
  freeQuantity: number;

  // =========================================================
  // نوع C: محرک → پاداش متفاوت
  // =========================================================

  /** دامنه‌ی محصولات پاداش */
  @Column({ type: 'enum', enum: PromotionScope, nullable: true })
  rewardScope: PromotionScope | null;

  @ManyToMany(() => Product)
  @JoinTable({
    name: 'promotion_reward_products',
    joinColumn: { name: 'promotion_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'product_id', referencedColumnName: 'id' },
  })
  rewardProducts: Product[];

  @ManyToMany(() => Category)
  @JoinTable({
    name: 'promotion_reward_categories',
    joinColumn: { name: 'promotion_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'category_id', referencedColumnName: 'id' },
  })
  rewardCategories: Category[];

  /** اگر دامنه‌ی پاداش خالی باشد، از این محصول/دسته استفاده می‌شود */
  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'suggested_product_id' })
  suggestedProduct: Product | null;

  @Column({ type: 'int', nullable: true })
  suggestedProductId: number | null;

  @ManyToOne(() => Category, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'suggested_category_id' })
  suggestedCategory: Category | null;

  @Column({ type: 'int', nullable: true })
  suggestedCategoryId: number | null;

  /** تعداد کالای رایگان */
  @Column({ type: 'int', default: 1 })
  rewardQuantity: number;

  /** انتخاب کالای رایگان توسط مشتری یا سیستم */
  @Column({
    type: 'enum',
    enum: FreeItemSelection,
    default: FreeItemSelection.AUTO,
  })
  freeItemSelection: FreeItemSelection;

  /** پاداش به‌طور خودکار به سبد اضافه شود یا بعد از تأیید مشتری */
  @Column({ type: 'boolean', default: false })
  autoAddReward: boolean;

  /** پاداش نیاز به تأیید مشتری (برای پاپ‌آپ قبل از سبد) */
  @Column({ type: 'boolean', default: false })
  requiresCustomerAcceptance: boolean;

  /** آیا پاداش رایگان باید با حذف شرط هم حذف شود */
  @Column({ type: 'boolean', default: true })
  removeRewardWhenTriggerRemoved: boolean;

  // =========================================================
  // زمان‌بندی و وضعیت
  // =========================================================

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'datetime' })
  startsAt: Date;

  @Column({ type: 'datetime' })
  expiresAt: Date;

  // =========================================================
  // محدودیت استفاده
  // =========================================================

  /** null = نامحدود */
  @Column({ type: 'int', nullable: true })
  maxTotalUses: number | null;

  /** null = نامحدود */
  @Column({ type: 'int', nullable: true })
  maxUsesPerCustomer: number | null;

  /** حداکثر تعداد دفعات اعمال در یک سبد */
  @Column({ type: 'int', default: 1 })
  maxApplicationsPerCart: number;

  // =========================================================
  // قواعد ترکیب
  // =========================================================

  /** آیا این پروموشن با بقیه ترکیب می‌شود */
  @Column({ type: 'boolean', default: false })
  canStack: boolean;

  /** اگر true، فقط با پروموشن‌هایی که in استک هستند و این هم قبول دارد، ترکیب می‌شود */
  @Column({ type: 'boolean', default: false })
  stackable: boolean;

  /** اولویت اعمال؛ عدد بزرگ‌تر زودتر */
  @Column({ type: 'int', default: 0 })
  priority: number;

  // =========================================================
  // نمایش به مشتری
  // =========================================================

  @Column({ type: 'varchar', length: 120, nullable: true })
  badgeText: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  customerDescription: string | null;

  @Column({ type: 'boolean', default: false })
  showBadgeOnProductCard: boolean;

  @Column({ type: 'boolean', default: false })
  showBadgeOnProductPage: boolean;

  // =========================================================
  // پاپ‌آپ پیش از سبد
  // =========================================================

  @Column({ type: 'boolean', default: false })
  showPreCartPopup: boolean;

  @Column({ type: 'varchar', length: 150, nullable: true })
  popupTitle: string | null;

  @Column({ type: 'text', nullable: true })
  popupDescription: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  popupAcceptLabel: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  popupDismissLabel: string | null;

  @Column({ type: 'int', nullable: true })
  popupSuggestedProductId: number | null;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'popup_suggested_product_id' })
  popupSuggestedProduct: Product | null;

  @Column({ type: 'int', nullable: true })
  popupSuggestedCategoryId: number | null;

  @ManyToOne(() => Category, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'popup_suggested_category_id' })
  popupSuggestedCategory: Category | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
