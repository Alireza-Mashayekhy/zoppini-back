import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';

import { ConsentDto, EventDto, ReportDto } from './analytics.dto';
import { AnalyticsService } from './analytics.service';
function safeFailure(error: unknown): never {
  if (error instanceof HttpException) throw error;
  throw new ServiceUnavailableException('Privacy service unavailable');
}
const strict = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
@Controller('privacy')
export class PrivacyController {
  constructor(private readonly service: AnalyticsService) {}
  @Post('consent')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  consent(
    @Headers('x-privacy-proxy') key: string,
    @Body(strict) dto: ConsentDto,
  ) {
    this.service.trusted(key);
    return this.service.consent(dto).catch(safeFailure);
  }
  @Post('event')
  @Throttle({ default: { limit: 90, ttl: 60000 } })
  event(
    @Headers('x-privacy-proxy') key: string,
    @Headers('x-analytics-context') token: string,
    @Body(strict) dto: EventDto,
  ) {
    this.service.trusted(key);
    return this.service.event(dto, token).catch(safeFailure);
  }
}
@Controller('admin/analytics')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class AnalyticsAdminController {
  constructor(private readonly service: AnalyticsService) {}
  @Get(':kind') report(
    @Param('kind') kind: string,
    @Query(strict) q: ReportDto,
  ) {
    return this.service.report(kind, q);
  }
}
