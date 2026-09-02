import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { QueryDto } from 'src/common/query';
import { FileSizeValidationPipe } from 'src/files/validation/fileSize.validator';
import { FileSizeArrayValidationPipe } from 'src/files/validation/fileSizeArray.validator';
import { RahkaranProductSyncService } from 'src/rahkaran/rahkaran-product-sync.service';

import {
  AddColorDto,
  AddSizeDto,
  CreateProductDto,
} from './dto/create-product.dto';
import { RahkaranProductsQueryDto } from './dto/rahkaran-products-query.dto';
import { UpdateColorDto } from './dto/update-color.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateSameColorProductsDto } from './dto/update-same-color-products.dto';
import { UpdateSizeDto } from './dto/update-size.dto';
import { UpdateSuggestedProductsDto } from './dto/update-suggested-products.dto';
import { ProductsService } from './products.service';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin, Role.Seo)
@Controller('admin/products')
export class AdmiProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly rahkaranProductSyncService: RahkaranProductSyncService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async create(
    @Body() createProductDto: CreateProductDto,
    @UploadedFile(new FileSizeValidationPipe()) file: Express.Multer.File,
  ) {
    return this.productsService.create(createProductDto, file);
  }

  @Post(':productId/color-images')
  @UseInterceptors(FilesInterceptor('files', 20))
  async uploadColorImages(
    @Param('productId') productId: number,
    @UploadedFiles(new FileSizeArrayValidationPipe())
    files: Express.Multer.File[],
    @Body() body: { colorIds?: string },
  ) {
    const colorIds = body.colorIds ? JSON.parse(body.colorIds) : [];

    if (files.length !== colorIds.length) {
      throw new BadRequestException(
        'تعداد فایل‌ها و تعداد رنگ‌ها باید برابر باشد',
      );
    }

    return this.productsService.addColorImages(productId, files, colorIds);
  }

  @Patch(':productId/color-images/order')
  async updateColorImagesOrder(
    @Param('productId') productId: number,
    @Body() body: { orders: { id: number; order: number }[] },
  ) {
    return this.productsService.updateColorImagesOrder(productId, body.orders);
  }

  @Delete('images/:id')
  async deleteImage(@Param('id') id: number) {
    return this.productsService.deleteImage(id);
  }

  @Post('/color')
  async addColor(@Body() addColorDto: AddColorDto) {
    return this.productsService.addColor(addColorDto);
  }

  @Post('/size')
  async addSize(@Body() addSizeDto: AddSizeDto) {
    return this.productsService.addSize(addSizeDto);
  }

  @Get()
  findAll(
    @Query() query: QueryDto,
    @Query('categoryIds') categoryIds?: string,
    @Query('colorIds') colorIds?: string,
    @Query('sizeIds') sizeIds?: string,
  ) {
    const filters = {
      categoryIds: categoryIds ? categoryIds.split(',').map(Number) : undefined,
      colorIds: colorIds ? colorIds.split(',').map(Number) : undefined,
      sizeIds: sizeIds ? sizeIds.split(',').map(Number) : undefined,
    };

    return this.productsService.findAll(query, filters, {
      onlyInStock: false,
    });
  }

  @Get('/color')
  allColors() {
    return this.productsService.allColors();
  }

  @Get('/size')
  allSizes() {
    return this.productsService.allSizes();
  }

  @Get(':slug')
  findOne(@Param('slug') slug: string) {
    return this.productsService.findOne(slug, {
      onlyInStock: false,
    });
  }

  @Patch(':id')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  update(
    @Param('id') id: number,
    @Body() updateProductDto: UpdateProductDto,
    @UploadedFile(new FileSizeValidationPipe({ optional: true }))
    file?: Express.Multer.File,
  ) {
    return this.productsService.update(+id, updateProductDto, file);
  }

  @Patch(':id/same-color-products')
  async updateSameColorProducts(
    @Param('id') id: number,
    @Body() dto: UpdateSameColorProductsDto,
  ) {
    return this.productsService.updateSameColorProducts(id, dto.productIds);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.productsService.remove(+id);
  }

  @Patch(':id/suggested-products')
  async updateSuggestedProducts(
    @Param('id') id: number,
    @Body() dto: UpdateSuggestedProductsDto,
  ) {
    return this.productsService.updateSuggestedProducts(
      id,
      dto.suggestedProductIds,
    );
  }

  @Patch('/color/:id')
  updateColor(@Param('id') id: number, @Body() updateColorDto: UpdateColorDto) {
    return this.productsService.updateColor(id, updateColorDto);
  }

  @Delete('/color/:id')
  deleteColor(@Param('id') id: number) {
    return this.productsService.deleteColor(id);
  }

  @Patch('/size/:id')
  updateSize(@Param('id') id: number, @Body() updateSizeDto: UpdateSizeDto) {
    return this.productsService.updateSize(id, updateSizeDto);
  }

  @Delete('/size/:id')
  deleteSize(@Param('id') id: number) {
    return this.productsService.deleteSize(id);
  }

  @Get('rahkaran/search')
  async searchRahkaranProducts(@Query() query: RahkaranProductsQueryDto) {
    return this.productsService.searchRahkaranProducts(
      query.search ?? '',
      query.page ?? 1,
      query.count ?? 20,
    );
  }

  @Get('rahkaran/barcode/:barcode')
  async getRahkaranProductByBarcode(@Param('barcode') barcode: string) {
    return this.productsService.getRahkaranProductByBarcode(barcode);
  }

  @Post('sync-rahkaran')
  syncAllProductsWithRahkaran() {
    // عمداً await نمی‌کنیم
    void this.productsService.syncAllProductsWithRahkaran();

    return {
      message: 'همگام‌سازی تمام محصولات با راهکاران در پس‌زمینه شروع شد.',
    };
  }

  @Post(':id/sync-rahkaran')
  async syncProductWithRahkaran(@Param('id', ParseIntPipe) id: number) {
    const variants = await this.productsService.syncProductWithRahkaran(id);

    return {
      message: 'محصول با موفقیت با راهکاران همگام شد.',
      updatedVariants: variants,
    };
  }
}
