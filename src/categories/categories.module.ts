import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FilesModule } from 'src/files/files.module';

import { CategoriesAdminController } from './categories.admin.controller';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { Category } from './entities/category.entity';

@Module({
  imports: [FilesModule, TypeOrmModule.forFeature([Category])],
  controllers: [CategoriesController, CategoriesAdminController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
