import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { OptionalAuthGuard } from 'src/common/guards/optional-auth.guard';

import { CreateVisitDto } from './dto/create-visit.dto';
import { VisitsService } from './visits.service';

@Controller('visits')
@UseGuards(OptionalAuthGuard)
export class VisitsController {
  constructor(private readonly visitsService: VisitsService) {}

  @Post()
  track(@Body() dto: CreateVisitDto, @Req() request: Request) {
    return this.visitsService.track(dto, request);
  }
}
