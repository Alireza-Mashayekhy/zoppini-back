import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { OptionalAuthGuard } from 'src/common/guards/optional-auth.guard';

import { CreateGamificationParticipationDto } from './dto/create-gamification.dto';
import { GamificationService } from './gamification.service';

@Controller('gamification')
@UseGuards(OptionalAuthGuard)
export class GamificationController {
  constructor(private readonly gamificationService: GamificationService) {}

  @Post('participations')
  create(@Body() dto: CreateGamificationParticipationDto) {
    return this.gamificationService.create(dto);
  }
}
