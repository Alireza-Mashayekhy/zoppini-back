import { Module } from '@nestjs/common';

import { FilesAdminController } from './files.admin.controller';
import { FilesService } from './files.service';

@Module({
  controllers: [FilesAdminController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
