// src/colors/entities/color.entity.ts
import { ProductColorImage } from 'src/products/entities/product-color-image.entity';
import { Variant } from 'src/products/entities/variant.entity';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class Color {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 50, unique: true })
  name: string;

  @Column({ length: 7, unique: true })
  hexCode: string;

  @OneToMany(() => Variant, variant => variant.color)
  variants: Variant[];

  @OneToMany(() => ProductColorImage, image => image.color)
  productImages: ProductColorImage[];
}
