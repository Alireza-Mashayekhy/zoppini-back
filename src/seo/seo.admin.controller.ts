import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { QueryDto } from 'src/common/query';

import { CreatePageSeoDto } from './dto/create-page-seo.dto';
import { UpdatePageSeoDto } from './dto/update-page-seo.dto';
import { SeoService } from './seo.service';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin, Role.Seo)
@Controller('admin/seo/pages')
export class SeoAdminController {
  constructor(private readonly seoService: SeoService) {}

  @Get()
  findAll(@Query() query: QueryDto) {
    return this.seoService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.seoService.findOne(id);
  }

  @Post()
  create(@Body() createPageSeoDto: CreatePageSeoDto) {
    return this.seoService.create(createPageSeoDto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updatePageSeoDto: UpdatePageSeoDto,
  ) {
    return this.seoService.update(id, updatePageSeoDto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.seoService.remove(id);
  }
}
