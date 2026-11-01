import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FilesModule } from 'src/files/files.module';

import { SiteImage } from './entities/site-image.entity';
import { SiteImagesAdminController } from './site-images.admin.controller';
import { SiteImagesController } from './site-images.controller';
import { SiteImagesService } from './site-images.service';

@Module({
  imports: [TypeOrmModule.forFeature([SiteImage]), FilesModule],
  controllers: [SiteImagesController, SiteImagesAdminController],
  providers: [SiteImagesService],
  exports: [SiteImagesService],
})
export class SiteImagesModule {}
