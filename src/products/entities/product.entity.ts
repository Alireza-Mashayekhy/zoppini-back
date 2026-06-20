import { Category } from 'src/categories/entities/category.entity';
import {
  Column,
  Entity,
  JoinTable,
  ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Comment } from './comment.entity';
import { ProductColorImage } from './product-color-image.entity';
import { Variant } from './variant.entity';

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, length: 50 })
  productCode: string;

  @Column({ length: 200 })
  title: string;

  @Column({ unique: true })
  slug: string;

  @Column({
    nullable: true,
  })
  image: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'text', nullable: true })
  careInstructionsHtml: string;

  @Column({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;

  @Column({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
  })
  updatedAt: Date;

  @ManyToMany(() => Product, product => product.suggestedBy, {
    cascade: true,
  })
  @JoinTable({
    name: 'product_suggestions',
    joinColumn: { name: 'product_id', referencedColumnName: 'id' },
    inverseJoinColumn: {
      name: 'suggested_product_id',
      referencedColumnName: 'id',
    },
  })
  suggestedProducts: Product[];

  @ManyToMany(() => Category, category => category.products)
  @JoinTable({
    name: 'product_categories',
    joinColumn: { name: 'product_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'category_id', referencedColumnName: 'id' },
  })
  categories: Category[];

  @ManyToMany(() => Product, product => product.suggestedProducts)
  suggestedBy: Product[];

  // ارتباط یک‑به‑چند با واریانت‌ها
  @OneToMany(() => Variant, variant => variant.product, { cascade: true })
  variants: Variant[];

  // ارتباط یک‑به‑چند با نظرات
  @OneToMany(() => Comment, comment => comment.product, { cascade: true })
  comments: Comment[];

  @OneToMany(() => ProductColorImage, image => image.product, { cascade: true })
  colorImages: ProductColorImage[];
}
