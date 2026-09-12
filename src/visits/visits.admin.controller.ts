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

import { VisitsService } from './visits.service';

@Controller('admin/visits')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class VisitsAdminController {
  constructor(private readonly visitsService: VisitsService) {}

  @Get('stats')
  getStats() {
    return this.visitsService.getStats();
  }

  @Get()
  findAll(@Query() query: QueryDto) {
    return this.visitsService.findAll(query);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.visitsService.remove(id);
  }
}
