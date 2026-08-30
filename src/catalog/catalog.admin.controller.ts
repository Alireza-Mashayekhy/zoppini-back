import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { FileSizeValidationPipe } from 'src/files/validation/fileSize.validator';

import { CatalogService } from './catalog.service';
import { CreateCatalogDto } from './dto/create-catalog.dto';

@Controller('admin/catalog')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class CatalogAdminController {
  constructor(private readonly catalogService: CatalogService) {}

  @Post('pages')
  @UseInterceptors(FileInterceptor('image'))
  async createPage(
    @UploadedFile(new FileSizeValidationPipe()) file: Express.Multer.File,
    @Body() dto: CreateCatalogDto,
  ) {
    if (!file) {
      throw new BadRequestException('تصویر الزامی است');
    }

    return this.catalogService.createPage(dto.page, file);
  }

  @Get('pages')
  async getPages() {
    return this.catalogService.getPages();
  }

  @Patch('pages/:id')
  @UseInterceptors(FileInterceptor('image'))
  async updatePage(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('تصویر الزامی است');
    }

    return this.catalogService.updatePage(id, file);
  }

  @Delete('pages/:id')
  async deletePage(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalogService.deletePage(id);
  }
}
