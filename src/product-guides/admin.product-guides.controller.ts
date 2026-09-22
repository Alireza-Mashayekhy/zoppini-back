import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { QueryDto } from 'src/common/query';

import {
  ApplyAssignmentDto,
  AssignGuidesDto,
  DuplicateGuideDto,
  ReorderMeasurementImagesDto,
  UpdateMeasurementImageDto,
  UpsertCareGuideDto,
  UpsertMeasurementGuideDto,
  UpsertProductGuideSettingDto,
  UpsertProductOverrideDto,
  UpsertSizeTableDto,
} from './dto/product-guides.dto';
import { GuideType } from './guide-enums';
import { ProductGuidesService } from './product-guides.service';

const GUIDE_TYPES = new Set<string>(Object.values(GuideType));

const parseGuideType = (value: string): GuideType => {
  if (!GUIDE_TYPES.has(value)) {
    throw new BadRequestException(`نوع راهنمای نامعتبر: ${value}`);
  }

  return value as GuideType;
};

const parseBoolean = (value?: string) =>
  value === 'true' || value === '1' || value === 'yes';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin, Role.Seo)
@Controller('admin/product-guides')
export class ProductGuidesAdminController {
  constructor(private readonly productGuidesService: ProductGuidesService) {}

  // ============================================================
  // جدول‌های سایزبندی
  // ============================================================

  @Get('size-tables')
  listSizeTables(@Query() query: QueryDto) {
    return this.productGuidesService.listSizeTables(query);
  }

  @Post('size-tables')
  createSizeTable(@Body() dto: UpsertSizeTableDto) {
    return this.productGuidesService.createSizeTable(dto);
  }

  @Get('size-tables/:id')
  getSizeTable(@Param('id') id: string) {
    return this.productGuidesService.getSizeTable(+id);
  }

  @Patch('size-tables/:id')
  updateSizeTable(@Param('id') id: string, @Body() dto: UpsertSizeTableDto) {
    return this.productGuidesService.updateSizeTable(+id, dto);
  }

  @Post('size-tables/:id/duplicate')
  duplicateSizeTable(@Param('id') id: string, @Body() dto: DuplicateGuideDto) {
    return this.productGuidesService.duplicateSizeTable(+id, dto.name);
  }

  @Patch('size-tables/:id/archive')
  archiveSizeTable(
    @Param('id') id: string,
    @Body() body: { isArchived?: boolean },
  ) {
    return this.productGuidesService.setSizeTableArchived(
      +id,
      body.isArchived !== false,
    );
  }

  @Delete('size-tables/:id')
  deleteSizeTable(
    @Param('id') id: string,
    @Query('replaceWithId') replaceWithId?: string,
    @Query('force') force?: string,
  ) {
    return this.productGuidesService.deleteGuide(GuideType.SIZE_TABLE, +id, {
      replaceWithId: replaceWithId ? +replaceWithId : undefined,
      force: parseBoolean(force),
    });
  }

  // ============================================================
  // راهنماهای شست‌وشو
  // ============================================================

  @Get('care-guides')
  listCareGuides(@Query() query: QueryDto) {
    return this.productGuidesService.listCareGuides(query);
  }

  @Post('care-guides')
  createCareGuide(@Body() dto: UpsertCareGuideDto) {
    return this.productGuidesService.createCareGuide(dto);
  }

  @Get('care-guides/:id')
  getCareGuide(@Param('id') id: string) {
    return this.productGuidesService.getCareGuide(+id);
  }

  @Patch('care-guides/:id')
  updateCareGuide(@Param('id') id: string, @Body() dto: UpsertCareGuideDto) {
    return this.productGuidesService.updateCareGuide(+id, dto);
  }

  @Post('care-guides/:id/duplicate')
  duplicateCareGuide(@Param('id') id: string, @Body() dto: DuplicateGuideDto) {
    return this.productGuidesService.duplicateCareGuide(+id, dto.name);
  }

  @Patch('care-guides/:id/archive')
  archiveCareGuide(
    @Param('id') id: string,
    @Body() body: { isArchived?: boolean },
  ) {
    return this.productGuidesService.setCareGuideArchived(
      +id,
      body.isArchived !== false,
    );
  }

  @Delete('care-guides/:id')
  deleteCareGuide(
    @Param('id') id: string,
    @Query('replaceWithId') replaceWithId?: string,
    @Query('force') force?: string,
  ) {
    return this.productGuidesService.deleteGuide(GuideType.CARE_GUIDE, +id, {
      replaceWithId: replaceWithId ? +replaceWithId : undefined,
      force: parseBoolean(force),
    });
  }

  // ============================================================
  // تصاویر روش اندازه‌گیری
  // ============================================================

  @Get('measurement-guides')
  listMeasurementGuides(@Query() query: QueryDto) {
    return this.productGuidesService.listMeasurementGuides(query);
  }

  @Post('measurement-guides')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: memoryStorage(),
    }),
  )
  createMeasurementGuide(
    @Body() dto: UpsertMeasurementGuideDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.productGuidesService.createMeasurementGuide(dto, files ?? []);
  }

  @Get('measurement-guides/:id')
  getMeasurementGuide(@Param('id') id: string) {
    return this.productGuidesService.getMeasurementGuide(+id);
  }

  @Patch('measurement-guides/:id')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: memoryStorage(),
    }),
  )
  updateMeasurementGuide(
    @Param('id') id: string,
    @Body() dto: UpsertMeasurementGuideDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.productGuidesService.updateMeasurementGuide(
      +id,
      dto,
      files ?? [],
    );
  }

  @Post('measurement-guides/:id/duplicate')
  duplicateMeasurementGuide(
    @Param('id') id: string,
    @Body() dto: DuplicateGuideDto,
  ) {
    return this.productGuidesService.duplicateMeasurementGuide(+id, dto.name);
  }

  @Patch('measurement-guides/:id/archive')
  archiveMeasurementGuide(
    @Param('id') id: string,
    @Body() body: { isArchived?: boolean },
  ) {
    return this.productGuidesService.setMeasurementGuideArchived(
      +id,
      body.isArchived !== false,
    );
  }

  @Delete('measurement-guides/:id')
  deleteMeasurementGuide(
    @Param('id') id: string,
    @Query('replaceWithId') replaceWithId?: string,
    @Query('force') force?: string,
  ) {
    return this.productGuidesService.deleteGuide(
      GuideType.MEASUREMENT_GUIDE,
      +id,
      {
        replaceWithId: replaceWithId ? +replaceWithId : undefined,
        force: parseBoolean(force),
      },
    );
  }

  @Patch('measurement-guides/:guideId/images/order')
  reorderMeasurementImages(
    @Param('guideId') guideId: string,
    @Body() dto: ReorderMeasurementImagesDto,
  ) {
    return this.productGuidesService.reorderMeasurementImages(
      +guideId,
      dto.imageIds,
    );
  }

  @Patch('measurement-guides/:guideId/images/:imageId')
  updateMeasurementImage(
    @Param('guideId') guideId: string,
    @Param('imageId') imageId: string,
    @Body() dto: UpdateMeasurementImageDto,
  ) {
    return this.productGuidesService.updateMeasurementImage(
      +guideId,
      +imageId,
      dto,
    );
  }

  @Delete('measurement-guides/:guideId/images/:imageId')
  deleteMeasurementImage(
    @Param('guideId') guideId: string,
    @Param('imageId') imageId: string,
  ) {
    return this.productGuidesService.deleteMeasurementImage(+guideId, +imageId);
  }

  // ============================================================
  // کاربرد راهنما در دسته‌ها و محصولات
  // ============================================================

  @Get('usage/:type/:id')
  getGuideUsage(@Param('type') type: string, @Param('id') id: string) {
    return this.productGuidesService.getGuideUsage(parseGuideType(type), +id);
  }

  @Post('assignments/preview')
  previewAssignment(@Body() dto: AssignGuidesDto) {
    return this.productGuidesService.previewAssignment(dto);
  }

  @Post('assignments')
  applyAssignment(@Body() dto: ApplyAssignmentDto) {
    return this.productGuidesService.applyAssignment(dto);
  }

  // ============================================================
  // راهنمای یک محصول
  // ============================================================

  @Get('products/:productId')
  getProductGuideState(@Param('productId') productId: string) {
    return this.productGuidesService.getProductGuideState(+productId);
  }

  @Patch('products/:productId/setting')
  upsertProductSetting(
    @Param('productId') productId: string,
    @Body() dto: Omit<UpsertProductGuideSettingDto, 'productId'>,
  ) {
    return this.productGuidesService.upsertProductSetting({
      ...dto,
      productId: +productId,
    });
  }

  @Post('products/:productId/overrides')
  upsertProductOverride(
    @Param('productId') productId: string,
    @Body() dto: UpsertProductOverrideDto,
  ) {
    return this.productGuidesService.upsertProductOverride(+productId, dto);
  }

  @Delete('products/:productId/overrides')
  clearProductOverrides(
    @Param('productId') productId: string,
    @Query('onlyPending') onlyPending?: string,
  ) {
    return this.productGuidesService.clearProductOverrides(+productId, {
      onlyPending: parseBoolean(onlyPending),
    });
  }

  @Delete('products/:productId/overrides/:overrideId')
  deleteProductOverride(
    @Param('productId') productId: string,
    @Param('overrideId') overrideId: string,
  ) {
    return this.productGuidesService.deleteProductOverride(
      +productId,
      +overrideId,
    );
  }

  @Post('products/:productId/overrides/:overrideId/rebase')
  rebaseProductOverride(
    @Param('productId') productId: string,
    @Param('overrideId') overrideId: string,
  ) {
    return this.productGuidesService.rebaseProductOverride(
      +productId,
      +overrideId,
    );
  }
}
