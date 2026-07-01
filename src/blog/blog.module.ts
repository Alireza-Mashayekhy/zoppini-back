import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FilesModule } from 'src/files/files.module';

import { BlogAdminController } from './blog.admin.controller';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';
import { BlogPost } from './entities/blog-post.entity';

@Module({
  imports: [FilesModule, TypeOrmModule.forFeature([BlogPost])],
  controllers: [BlogController, BlogAdminController],
  providers: [BlogService],
  exports: [BlogService],
})
export class BlogModule {}
