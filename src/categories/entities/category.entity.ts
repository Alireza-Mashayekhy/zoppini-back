import { Product } from 'src/products/entities/product.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class Category {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    length: 255,
  })
  name: string;

  @Column({
    nullable: true,
  })
  image: string;

  @Column()
  description: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({
    default: true,
  })
  isActive: boolean;

  @Column({
    unique: true,
  })
  slug: string;

  @Column()
  isInHeroSection: boolean;

  @Column()
  isInHome: boolean;

  @Column({ default: 0 })
  orderInHome: number;

  @Column({ default: 0 })
  orderInHero: number;

  @Column({
    nullable: true,
  })
  parentId: string | null;

  @ManyToOne(() => Category, category => category.children, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'parentId',
  })
  parent: Category | null;

  @OneToMany(() => Category, category => category.parent)
  children: Category[];

  @ManyToMany(() => Product, product => product.categories)
  products: Product[];
}
