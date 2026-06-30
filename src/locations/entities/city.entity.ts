import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Province } from './province.entity';

@Entity('cities')
@Index(['provinceId'])
@Index(['name'])
export class City {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 100 })
  name: string;

  @Column({ unique: true, length: 100 })
  slug: string;

  @Column({ name: 'province_id' })
  provinceId: number;

  @Column({ type: 'json', nullable: true })
  location: {
    latitude: number;
    longitude: number;
  };

  @ManyToOne(() => Province, province => province.cities)
  @JoinColumn({ name: 'province_id' })
  province: Province;
}
