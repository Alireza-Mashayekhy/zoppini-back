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
@Unique(['product', 'color', 'size'])
export class Variant {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number;

  @Column({ default: 0 })
  stock: number;

  @Column({ nullable: true, unique: true })
  sku: string;

  // ارتباط با محصول
  @ManyToOne(() => Product, product => product.variants, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @ManyToOne(() => Color, color => color.variants, {
    onDelete: 'CASCADE',
    nullable: false, // ← NOT NULL
  })
  @JoinColumn({ name: 'color_id' })
  color: Color;

  @ManyToOne(() => Size, size => size.variants, {
    onDelete: 'CASCADE',
    nullable: false, // ← NOT NULL
  })
  @JoinColumn({ name: 'size_id' })
  size: Size;
}
