import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { Product } from './product.entity';
import { Color } from './product-color.entity';
import { Size } from './product-size.entity';

@Entity()
@Unique(['productId', 'colorId', 'sizeId'])
export class Variant {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  price: number;

  @Column({ default: 0 })
  stock: number;

  /**
   * موجودی انبار خرده‌فروشی (StoreID = 20)
   *
   * با Sync از راهکاران به‌روز می‌شود.
   */
  @Column({ name: 'stock_retail', default: 0 })
  stockRetail: number;

  /**
   * موجودی انبار هدیش مال (StoreID = 23)
   *
   * با Sync از راهکاران به‌روز می‌شود.
   */
  @Column({ name: 'stock_hadish_mall', default: 0 })
  stockHadishMall: number;

  @Column({ type: 'varchar', length: 255, nullable: true, unique: true })
  sku: string | null;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date;

  @Column({ name: 'product_id' })
  productId: number;

  @Column({ name: 'color_id' })
  colorId: number;

  @Column({ name: 'size_id' })
  sizeId: number;

  @ManyToOne(() => Product, product => product.variants, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @ManyToOne(() => Color, color => color.variants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'color_id' })
  color: Color;

  @ManyToOne(() => Size, size => size.variants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'size_id' })
  size: Size;
}
