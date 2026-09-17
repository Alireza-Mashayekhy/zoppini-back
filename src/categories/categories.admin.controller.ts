import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { QueryDto } from 'src/common/query';

import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import type { CategoryImageUploads } from './utils/category-images.util';
import {
  CATEGORY_IMAGE_FIELDS,
  pickCategoryImages,
} from './utils/category-images.util';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin, Role.Seo)
@Controller('admin/categories')
export class CategoriesAdminController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  @UseInterceptors(
    FileFieldsInterceptor([...CATEGORY_IMAGE_FIELDS], {
      storage: memoryStorage(),
    }),
  )
  create(
    @Body() createCategoryDto: CreateCategoryDto,
    @UploadedFiles() files: CategoryImageUploads,
  ) {
    return this.categoriesService.create(
      createCategoryDto,
      pickCategoryImages(files, { requirePrimary: true }),
    );
  }

  @Get()
  findAll(@Query() query: QueryDto) {
    return this.categoriesService.findAll({
      ...query,
      includeInactive: 'true',
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(+id);
  }

  @Patch(':id')
  @UseInterceptors(
    FileFieldsInterceptor([...CATEGORY_IMAGE_FIELDS], {
      storage: memoryStorage(),
    }),
  )
  update(
    @Param('id') id: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
    @UploadedFiles() files: CategoryImageUploads,
  ) {
    return this.categoriesService.update(
      +id,
      updateCategoryDto,
      pickCategoryImages(files),
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.categoriesService.remove(+id);
  }

  @Get('slug/:slug')
  async findBySlug(@Param('slug') slug: string) {
    const category = await this.categoriesService.findOneBySlug(slug);
    if (!category) {
      throw new NotFoundException('دسته‌بندی یافت نشد');
    }
    return category;
  }
}
