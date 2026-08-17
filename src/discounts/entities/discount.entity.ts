import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import { User } from 'src/users/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinTable,
  ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { DiscountUsage } from './discount-code-usage.entity';

export enum DiscountType {
  PERCENTAGE = 'percentage',
  FIXED = 'fixed',
}

export interface ProductDiscount {
  id: number;
  code: string;
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

  @Column({ unique: true, length: 100 })
  code: string;

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

  /**
   * اگر خالی باشد => محدودیت دسته‌بندی نداریم.
   *
   * اگر دسته داشته باشیم:
   * discount روی محصولات این دسته‌ها اعمال می‌شود.
   */
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

  @OneToMany(() => DiscountUsage, usage => usage.discount)
  usages: DiscountUsage[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
