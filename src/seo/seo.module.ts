import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PageSeo } from './entities/page-seo.entity';
import { SeoAdminController } from './seo.admin.controller';
import { SeoController } from './seo.controller';
import { SeoService } from './seo.service';

@Module({
  imports: [TypeOrmModule.forFeature([PageSeo])],
  controllers: [SeoController, SeoAdminController],
  providers: [SeoService],
  exports: [SeoService],
})
export class SeoModule {}
