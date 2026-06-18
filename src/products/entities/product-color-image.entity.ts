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

@Entity()
@Unique(['product', 'color', 'order'])
export class ProductColorImage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 500 })
  url: string;

  @Column({ default: 0 })
  order: number;

  @ManyToOne(() => Product, product => product.colorImages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @ManyToOne(() => Color, color => color.productImages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'color_id' })
  color: Color;
}
