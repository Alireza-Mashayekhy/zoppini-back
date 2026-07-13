import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { B2bAdminController } from './b2b-request.admin.controller';
import { B2BController } from './b2b-request.controller';
import { B2BService } from './b2b-request.service';
import { B2BRequest } from './entities/b2b-request.entity';

@Module({
  imports: [TypeOrmModule.forFeature([B2BRequest])],
  controllers: [B2BController, B2bAdminController],
  providers: [B2BService],
  exports: [B2BService],
})
export class B2bRequestModule {}
