import {
  Body,
  Controller,
  Delete,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';

import {
  CreateFeaturedProductDto,
  UpdateFeaturedProductDto,
} from './dto/create-featured-product.dto';
import { StyleService } from './style.service';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin/style')
export class AdminStyleController {
  constructor(private readonly styleService: StyleService) {}

  @Post()
  async createStyleProduct(@Body() dto: CreateFeaturedProductDto) {
    return this.styleService.createStyleProduct(dto);
  }

  @Patch(':id')
  async updateStyleProduct(
    @Param('id') id: number,
    @Body() dto: UpdateFeaturedProductDto,
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
