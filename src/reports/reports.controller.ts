import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';

import { ReportsQuery } from './reports.dto';
import { ReportsService } from './reports.service';

const strict = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
@Controller('admin/reports')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}
  @Get('summary') summary(@Query(strict) q: ReportsQuery) {
    return this.reports.summary(q);
  }
  @Get('interest')
  interest(@Query(strict) q: ReportsQuery) {
    return this.reports.interest(q);
  }
  @Get('tables/:kind') table(
    @Param('kind') kind: string,
    @Query(strict) q: ReportsQuery,
  ) {
    return this.reports.table(kind, q);
  }
  @Get('export/:kind') async export(
    @Param('kind') kind: string,
    @Query(strict) q: ReportsQuery,
    @Res() res: Response,
  ) {
    return this.reports.csv(kind, q, res);
  }
}
