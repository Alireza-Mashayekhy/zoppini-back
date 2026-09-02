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

import {
  CreateFeaturedProductDto,
  UpdateFeaturedProductDto,
} from './dto/create-featured-product.dto';
import { FeaturedService } from './featured.service';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin/featured')
export class AdminFeaturedController {
  constructor(private readonly featuredService: FeaturedService) {}

  @Get()
  async getFeaturedProducts() {
    return this.featuredService.getFeaturedProducts({
      onlyInStock: false,
    });
  }

  @Get(':id')
  async getFeaturedProduct(@Param('id') id: number) {
    return this.featuredService.getFeaturedProduct(id, {
      onlyInStock: false,
    });
  }

  @Post()
  async createFeaturedProduct(@Body() dto: CreateFeaturedProductDto) {
    return this.featuredService.createFeaturedProduct(dto);
  }

  @Patch(':id')
  async updateFeaturedProduct(
    @Param('id') id: number,
    @Body() dto: UpdateFeaturedProductDto,
  ) {
    return this.featuredService.updateFeaturedProduct(id, dto);
  }

  @Delete(':id')
  async deleteFeaturedProduct(@Param('id') id: number) {
    await this.featuredService.deleteFeaturedProduct(id);
    return { message: 'محصول ویژه با موفقیت حذف شد' };
  }

  @Delete('product/:productId/color/:colorId')
  async deleteFeaturedProductByProductAndColor(
    @Param('productId') productId: number,
    @Param('colorId') colorId: number,
  ) {
    await this.featuredService.deleteFeaturedProductByProductAndColor(
      productId,
      colorId,
    );
    return { message: 'محصول ویژه با موفقیت حذف شد' };
  }
}
