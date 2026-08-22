import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('catalog')
export class Catalog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  pageNumber: number;

  @Column({ type: 'varchar', length: 500 })
  image: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
