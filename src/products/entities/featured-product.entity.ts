// src/featured/entities/featured-product.entity.ts
import { Product } from 'src/products/entities/product.entity';
import { Color } from 'src/products/entities/product-color.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('featured_products')
export class FeaturedProduct {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ name: 'product_id' })
  productId: number;

  @ManyToOne(() => Color, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'color_id' })
  color: Color;

  @Column({ name: 'color_id' })
  colorId: number;

  @Column({ default: 0 })
  order: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
