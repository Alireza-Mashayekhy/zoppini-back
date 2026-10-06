import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileSizeValidationPipe } from 'src/files/validation/fileSize.validator';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { QueryDto } from 'src/common/query';

import { BlogService } from './blog.service';
import { CreateBlogPostDto } from './dto/create-blog-post.dto';
import { SaveBlogBlocksDto } from './dto/save-blog-blocks.dto';
import { UpdateBlogPostDto } from './dto/update-blog-post.dto';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin, Role.Seo)
@Controller('admin/blog')
export class BlogAdminController {
  constructor(private readonly blogService: BlogService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  create(
    @Body() createBlogPostDto: CreateBlogPostDto,
    @UploadedFile(new FileSizeValidationPipe()) file: Express.Multer.File,
  ) {
    return this.blogService.create(createBlogPostDto, file);
  }

  @Get()
  findAll(@Query() query: QueryDto) {
    return this.blogService.findAll(query);
  }

  /** بخش‌های مقاله (سوالات متداول، اسلایدر محصولات، مدیا و فهرست مطالب) */
  @Get(':id/blocks')
  findBlocks(@Param('id') id: string) {
    return this.blogService.getBlocks(+id);
  }

  /**
   * ذخیره‌ی ترتیب و محتوای بخش‌ها.
   * ترتیب آرایه در body همان ترتیب نمایش در مقاله است.
   */
  @Put(':id/blocks')
  saveBlocks(@Param('id') id: string, @Body() dto: SaveBlogBlocksDto) {
    return this.blogService.saveBlocks(+id, dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.blogService.findOne(+id);
  }

  @Patch(':id')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  update(
    @Param('id') id: string,
    @Body() updateBlogPostDto: UpdateBlogPostDto,
    @UploadedFile(new FileSizeValidationPipe({ optional: true }))
    file?: Express.Multer.File,
  ) {
    return this.blogService.update(+id, updateBlogPostDto, file);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.blogService.remove(+id);
  }
}
