import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { StyleProfileKey } from '../style-profile';
import { GamificationAnswer } from './gamification-answer.entity';

@Entity('gamification_participations')
export class GamificationParticipation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 150 })
  fullName: string;

  @Index()
  @Column({ type: 'varchar', length: 20 })
  phone: string;

  @Column({ type: 'datetime', nullable: true })
  birthDate: Date;

  @Index()
  @Column({
    name: 'style_profile_key',
    type: 'varchar',
    length: 10,
    nullable: true,
  })
  styleProfileKey: StyleProfileKey | null;

  @OneToMany(() => GamificationAnswer, answer => answer.participation, {
    cascade: true,
  })
  answers: GamificationAnswer[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  get answersText(): string {
    return [...(this.answers ?? [])]
      .sort((first, second) => first.questionNumber - second.questionNumber)
      .map(
        answer => `سوال ${answer.questionNumber}: گزینه ${answer.optionNumber}`,
      )
      .join(' | ');
  }
}
