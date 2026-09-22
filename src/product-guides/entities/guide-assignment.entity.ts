import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { GuideMode, GuideOverrideAction, GuideType } from '../guide-enums';
import { CareGuide } from './care-guide.entity';
import { MeasurementGuide } from './measurement-guide.entity';
import { SizeTable } from './size-table.entity';

export { GuideMode, GuideOverrideAction, GuideType };

@Entity('guide_category_settings')
export class CategoryGuideSetting {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToOne(() => Category, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'category_id' })
  category: Category;

  @Column({ name: 'category_id', unique: true })
  categoryId: number;

  @ManyToOne(() => SizeTable, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'size_table_id' })
  sizeTable: SizeTable | null;

  @Index()
  @Column({ name: 'size_table_id', nullable: true })
  sizeTableId: number | null;

  @ManyToOne(() => CareGuide, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'care_guide_id' })
  careGuide: CareGuide | null;

  @Index()
  @Column({ name: 'care_guide_id', nullable: true })
  careGuideId: number | null;

  @ManyToOne(() => MeasurementGuide, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'measurement_guide_id' })
  measurementGuide: MeasurementGuide | null;

  @Index()
  @Column({ name: 'measurement_guide_id', nullable: true })
  measurementGuideId: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

@Entity('guide_product_settings')
export class ProductGuideSetting {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ name: 'product_id', unique: true })
  productId: number;

  @Column({
    name: 'size_table_mode',
    type: 'enum',
    enum: GuideMode,
    default: GuideMode.INHERIT,
  })
  sizeTableMode: GuideMode;

  @ManyToOne(() => SizeTable, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'size_table_id' })
  sizeTable: SizeTable | null;

  @Index()
  @Column({ name: 'size_table_id', nullable: true })
  sizeTableId: number | null;

  @Column({
    name: 'care_guide_mode',
    type: 'enum',
    enum: GuideMode,
    default: GuideMode.INHERIT,
  })
  careGuideMode: GuideMode;

  @ManyToOne(() => CareGuide, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'care_guide_id' })
  careGuide: CareGuide | null;

  @Index()
  @Column({ name: 'care_guide_id', nullable: true })
  careGuideId: number | null;

  @Column({
    name: 'measurement_guide_mode',
    type: 'enum',
    enum: GuideMode,
    default: GuideMode.INHERIT,
  })
  measurementGuideMode: GuideMode;

  @ManyToOne(() => MeasurementGuide, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'measurement_guide_id' })
  measurementGuide: MeasurementGuide | null;

  @Index()
  @Column({ name: 'measurement_guide_id', nullable: true })
  measurementGuideId: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

@Entity('guide_product_overrides')
@Unique(['productId', 'guideType', 'targetKey'])
export class ProductGuideOverride {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Index()
  @Column({ name: 'product_id' })
  productId: number;

  @Column({ name: 'guide_type', type: 'enum', enum: GuideType })
  guideType: GuideType;

  @Column({ type: 'enum', enum: GuideOverrideAction })
  action: GuideOverrideAction;

  @Column({ name: 'target_key', length: 60 })
  targetKey: string;

  /** مقدار جدید متن/عدد یا شناسه تصویر جانشین */
  @Column({ type: 'varchar', length: 255, nullable: true })
  value: string | null;

  /** شناسه راهنمایی که این تغییر روی آن ثبت شده */
  @Column({ name: 'base_guide_id', type: 'int', nullable: true })
  baseGuideId: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
