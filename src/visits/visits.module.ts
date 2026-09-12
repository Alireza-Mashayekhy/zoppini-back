import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Visit } from './entities/visit.entity';
import { VisitsAdminController } from './visits.admin.controller';
import { VisitsController } from './visits.controller';
import { VisitsService } from './visits.service';

@Module({
  imports: [TypeOrmModule.forFeature([Visit])],
  controllers: [VisitsController, VisitsAdminController],
  providers: [VisitsService],
})
export class VisitsModule {}
