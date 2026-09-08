import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClubModule } from 'src/club/club.module';

import { GamificationAdminController } from './admin.gamification.controller';
import { GamificationAnswer } from './entities/gamification-answer.entity';
import { GamificationParticipation } from './entities/gamification-participation.entity';
import { GamificationController } from './gamification.controller';
import { GamificationService } from './gamification.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([GamificationParticipation, GamificationAnswer]),
    ClubModule,
  ],
  controllers: [GamificationController, GamificationAdminController],
  providers: [GamificationService],
  exports: [GamificationService],
})
export class GamificationModule {}
