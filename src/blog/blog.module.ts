import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FilesModule } from 'src/files/files.module';
import { Product } from 'src/products/entities/product.entity';

import { BlogAdminController } from './blog.admin.controller';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';
import { BlogBlock } from './entities/blog-block.entity';
import { BlogPost } from './entities/blog-post.entity';

@Module({
  imports: [
    FilesModule,
    TypeOrmModule.forFeature([BlogPost, BlogBlock, Product]),
  ],
  controllers: [BlogController, BlogAdminController],
  providers: [BlogService],
  exports: [BlogService],
})
export class BlogModule {}
