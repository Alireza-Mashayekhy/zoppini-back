import { Variant } from 'src/products/entities/variant.entity';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class Size {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 10, unique: true })
  name: string;

  @OneToMany(() => Variant, variant => variant.size)
  variants: Variant[];
}
