import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { GamificationParticipation } from './gamification-participation.entity';

@Entity('gamification_answers')
@Index(['participationId', 'questionNumber'], { unique: true })
export class GamificationAnswer {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(
    () => GamificationParticipation,
    participation => participation.answers,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({ name: 'participation_id' })
  participation: GamificationParticipation;

  @Column({ name: 'participation_id' })
  participationId: number;

  @Column({ name: 'question_number', type: 'int' })
  questionNumber: number;

  @Column({ name: 'option_number', type: 'int' })
  optionNumber: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
