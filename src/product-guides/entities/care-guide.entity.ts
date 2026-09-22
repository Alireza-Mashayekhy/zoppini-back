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

/** راهنمای شست‌وشو — نام + چند دستور مرتب */
@Entity('guide_care_guides')
export class CareGuide {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 150 })
  name: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Index()
  @Column({ default: false })
  isArchived: boolean;

  @OneToMany(() => CareInstruction, instruction => instruction.careGuide, {
    cascade: true,
  })
  instructions: CareInstruction[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

@Entity('guide_care_instructions')
export class CareInstruction {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => CareGuide, careGuide => careGuide.instructions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'care_guide_id' })
  careGuide: CareGuide;

  @Index()
  @Column({ name: 'care_guide_id' })
  careGuideId: number;

  @Column({ type: 'text' })
  text: string;

  /** کلید آیکون شست‌وشو (مثل wash-30) — اختیاری */
  @Column({ type: 'varchar', name: 'icon_key', length: 50, nullable: true })
  iconKey: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  order: number;
}
