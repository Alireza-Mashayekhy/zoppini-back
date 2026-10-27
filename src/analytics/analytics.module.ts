import { Module } from '@nestjs/common';

import {
  AnalyticsAdminController,
  PrivacyController,
} from './analytics.controller';
import { AnalyticsService } from './analytics.service';
@Module({
  controllers: [PrivacyController, AnalyticsAdminController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
