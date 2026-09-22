import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('guide_measurement_guides')
export class MeasurementGuide {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 150 })
  name: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Index()
  @Column({ default: false })
  isArchived: boolean;

  @OneToMany(() => MeasurementImage, image => image.measurementGuide, {
    cascade: true,
  })
  images: MeasurementImage[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

@Entity('guide_measurement_images')
export class MeasurementImage {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => MeasurementGuide, guide => guide.images, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'measurement_guide_id' })
  measurementGuide: MeasurementGuide;

  @Index()
  @Column({ name: 'measurement_guide_id' })
  measurementGuideId: number;

  /** نام فایل در پوشه uploads */
  @Column({ length: 255 })
  file: string;

  /** توضیح تصویر — اختیاری */
  @Column({ type: 'varchar', length: 255, nullable: true })
  caption: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  order: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
