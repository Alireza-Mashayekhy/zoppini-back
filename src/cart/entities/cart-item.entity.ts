import { Variant } from 'src/products/entities/variant.entity';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Cart } from './cart.entity';

@Entity()
export class CartItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Cart, cart => cart.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cart_id' })
  cart: Cart;

  @ManyToOne(() => Variant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'variant_id' })
  variant: Variant;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  /**
   * اگر این ردیف یک «کالای رایگان» پروموشن باشد، شناسهٔ پروموشن اینجا ذخیره
   * می‌شود. چنین ردیفی:
   * - قیمت فهرست خودش را نگه می‌دارد تا «رایگان بودن» شفاف باشد،
   * - محرک هیچ پروموشن دیگری نیست،
   * - اگر شرط پروموشن از بین برود خودکار حذف می‌شود.
   */
  @Column({ name: 'promotion_reward_id', type: 'int', nullable: true })
  promotionRewardId: number | null;

  /**
   * پروموشنی که مشتری برای گرفتن این هدیه پذیرفته است (برای ردیف‌های عادی
   * لازم نیست؛ فقط برای ردیف هدیه مقدار دارد).
   */
  @Column({ name: 'added_via_promotion', type: 'boolean', default: false })
  addedViaPromotion: boolean;
}
