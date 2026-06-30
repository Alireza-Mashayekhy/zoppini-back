import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { City } from './city.entity';

@Entity('provinces')
export class Province {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 100 })
  name: string;

  @Column({ unique: true, length: 100 })
  slug: string;

  @Column({ name: 'tel_prefix', length: 5, nullable: true })
  telPrefix: string;

  @Column({ type: 'json', nullable: true })
  location: {
    latitude: number;
    longitude: number;
  };

  @OneToMany(() => City, city => city.province)
  cities: City[];
}
