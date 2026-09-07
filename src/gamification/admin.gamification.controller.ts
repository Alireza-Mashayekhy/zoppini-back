import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { QueryDto } from 'src/common/query';

import { GamificationService } from './gamification.service';

@Controller('admin/gamification')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class GamificationAdminController {
  constructor(private readonly gamificationService: GamificationService) {}

  @Get('stats')
  getStats(@Query() query: QueryDto) {
    return this.gamificationService.getStats(query);
  }

  @Get('participations')
  findAll(@Query() query: QueryDto) {
    return this.gamificationService.findAll(query);
  }

  @Get('participations/:id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.gamificationService.findOne(id);
  }

  @Delete('participations/:id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.gamificationService.remove(id);
  }
}
