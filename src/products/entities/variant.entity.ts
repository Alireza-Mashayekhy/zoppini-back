import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
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

  @Column({ type: 'varchar', length: 255, nullable: true, unique: true })
  sku: string | null;

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
