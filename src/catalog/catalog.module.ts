import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FilesService } from 'src/files/files.service';

import { CatalogAdminController } from './catalog.admin.controller';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { Catalog } from './entities/catalog.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Catalog])],
  controllers: [CatalogController, CatalogAdminController],
  providers: [CatalogService, FilesService],
})
export class CatalogModule {}
