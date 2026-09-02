import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';

import { CreateSuggestedProductDto } from './dto/create-suggested-style.dto';
import { StyleService } from './style.service';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin/style')
export class AdminStyleController {
  constructor(private readonly styleService: StyleService) {}

  @Get()
  async getStyleProducts() {
    return this.styleService.getStyleProducts({
      onlyInStock: false,
    });
  }

  @Get(':id')
  async getStyleProduct(@Param('id') id: number) {
    return this.styleService.getStyleProduct(id, {
      onlyInStock: false,
    });
  }

  @Post()
  async createStyleProduct(@Body() dto: CreateSuggestedProductDto) {
    return this.styleService.createStyleProduct(dto);
  }

  @Patch(':id')
  async updateStyleProduct(
    @Param('id') id: number,
    @Body() dto: CreateSuggestedProductDto,
  ) {
    return this.styleService.updateStyleProduct(id, dto);
  }

  @Delete(':id')
  async deleteStyleProduct(@Param('id') id: number) {
    await this.styleService.deleteStyleProduct(id);
    return { message: 'محصول ویژه با موفقیت حذف شد' };
  }

  @Delete('product/:productId/color/:colorId')
  async deleteStyleProductByProductAndColor(
    @Param('productId') productId: number,
    @Param('colorId') colorId: number,
  ) {
    await this.styleService.deleteStyleProductProductByProductAndColor(
      productId,
      colorId,
    );
    return { message: 'محصول ویژه با موفقیت حذف شد' };
  }
}
