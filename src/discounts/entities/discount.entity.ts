import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import { User } from 'src/users/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinTable,
  ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { DiscountUsage } from './discount-code-usage.entity';
import { DiscountRedemption } from './discount-redemption.entity';

export enum DiscountType {
  PERCENTAGE = 'percentage',
  FIXED = 'fixed',
}

export enum DiscountKind {
  SALE = 'sale',
  CODE = 'code',
}

export const OPENING_DISCOUNT_CODE = 'OPENING';

export interface ProductDiscount {
  id: number;
  code: string | null;
  title: string | null;
  type: DiscountType;
  value: number;
  maxDiscountAmount: number | null;
  discountAmount: number;
  finalPrice: number;
  originalPrice: number;
}

@Entity('discounts')
export class Discount {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({
    type: 'enum',
    enum: DiscountKind,
    default: DiscountKind.CODE,
  })
  kind: DiscountKind;

  /**
   * عنوان نمایشی (برای فروش ویژه)
   */
  @Column({ type: 'varchar', length: 150, nullable: true })
  title: string | null;

  /**
   * فقط برای kind = CODE الزامی است. فروش ویژه کد ندارد.
   */
  @Column({ type: 'varchar', unique: true, length: 100, nullable: true })
  code: string | null;

  @Column({
    type: 'enum',
    enum: DiscountType,
  })
  type: DiscountType;

  /**
   * اگر percentage باشد:
   * مثلا 20 یعنی 20 درصد
   *
   * اگر fixed باشد:
   * مثلا 100000 یعنی 100 هزار تومان
   */
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
  })
  value: number;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
  })
  maxDiscountAmount: number | null;

  /**
   * حداقل مبلغ سفارش برای استفاده از کد
   */
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
  })
  minOrderAmount: number | null;

  @Column({ type: 'int', nullable: true, default: 1 })
  maxUsesPerUser: number | null;

  @Column({ type: 'int', nullable: true })
  maxTotalUses: number | null;

  @Column({ default: false })
  excludeSaleItems: boolean;

  /**
   * فعال / غیرفعال بودن توسط ادمین
   */
  @Column({ default: true })
  isActive: boolean;

  /**
   * شروع اعتبار
   */
  @Column({ type: 'datetime' })
  startsAt: Date;

  /**
   * پایان اعتبار
   */
  @Column({ type: 'datetime' })
  expiresAt: Date;

  /**
   * اگر خالی باشد => همه کاربران
   * اگر پر باشد => فقط این کاربران
   */
  @ManyToMany(() => User)
  @JoinTable({
    name: 'discount_users',
    joinColumn: {
      name: 'discount_id',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'user_id',
      referencedColumnName: 'id',
    },
  })
  users: User[];

  /**
   * اگر خالی باشد => همه محصولات
   *
   * اگر محصول داشته باشیم:
   * discount روی این محصولات اعمال می‌شود.
   */
  @ManyToMany(() => Product)
  @JoinTable({
    name: 'discount_products',
    joinColumn: {
      name: 'discount_id',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'product_id',
      referencedColumnName: 'id',
    },
  })
  products: Product[];

  @ManyToMany(() => Category)
  @JoinTable({
    name: 'discount_categories',
    joinColumn: {
      name: 'discount_id',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'category_id',
      referencedColumnName: 'id',
    },
  })
  categories: Category[];

  @ManyToMany(() => Product)
  @JoinTable({
    name: 'discount_excluded_products',
    joinColumn: {
      name: 'discount_id',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'product_id',
      referencedColumnName: 'id',
    },
  })
  excludedProducts: Product[];

  @ManyToMany(() => Category)
  @JoinTable({
    name: 'discount_excluded_categories',
    joinColumn: {
      name: 'discount_id',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'category_id',
      referencedColumnName: 'id',
    },
  })
  excludedCategories: Category[];

  @OneToMany(() => DiscountUsage, usage => usage.discount)
  usages: DiscountUsage[];

  @OneToMany(() => DiscountRedemption, redemption => redemption.discount)
  redemptions: DiscountRedemption[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
