import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Category } from 'src/categories/entities/category.entity';
import { applySearch, getPagination, QueryDto } from 'src/common/query';
import { FilesService } from 'src/files/files.service';
import { FileSizeValidationPipe } from 'src/files/validation/fileSize.validator';
import { Product } from 'src/products/entities/product.entity';
import {
  DataSource,
  EntityTarget,
  In,
  ObjectLiteral,
  Repository,
} from 'typeorm';

import {
  AssignGuidesDto,
  UpsertCareGuideDto,
  UpsertMeasurementGuideDto,
  UpsertProductGuideSettingDto,
  UpsertProductOverrideDto,
  UpsertSizeTableDto,
} from './dto/product-guides.dto';
import { CareGuide, CareInstruction } from './entities/care-guide.entity';
import {
  CategoryGuideSetting,
  ProductGuideOverride,
  ProductGuideSetting,
} from './entities/guide-assignment.entity';
import {
  MeasurementGuide,
  MeasurementImage,
} from './entities/measurement-guide.entity';
import {
  SizeTable,
  SizeTableCell,
  SizeTableColumn,
  SizeTableRow,
} from './entities/size-table.entity';
import { GuideMode, GuideOverrideAction, GuideType } from './guide-enums';
import {
  CategoryGuideCandidate,
  ResolvedProductGuides,
  resolveProductGuides,
  ResolveProductGuidesInput,
} from './guide-resolution';
import { normalizeCellValue, normalizeText } from './utils/guide-value.util';

const fileSizeValidationPipe = new FileSizeValidationPipe({ optional: true });

/** فیلد راهنما در تنظیمات دسته/محصول برای هر نوع */
const GUIDE_COLUMNS: Record<GuideType, string> = {
  [GuideType.SIZE_TABLE]: 'sizeTableId',
  [GuideType.CARE_GUIDE]: 'careGuideId',
  [GuideType.MEASUREMENT_GUIDE]: 'measurementGuideId',
};

const MODE_COLUMNS: Record<GuideType, string> = {
  [GuideType.SIZE_TABLE]: 'sizeTableMode',
  [GuideType.CARE_GUIDE]: 'careGuideMode',
  [GuideType.MEASUREMENT_GUIDE]: 'measurementGuideMode',
};

@Injectable()
export class ProductGuidesService {
  private readonly logger = new Logger(ProductGuidesService.name);

  constructor(
    @InjectRepository(SizeTable)
    private readonly sizeTableRepo: Repository<SizeTable>,
    @InjectRepository(SizeTableColumn)
    private readonly columnRepo: Repository<SizeTableColumn>,
    @InjectRepository(SizeTableRow)
    private readonly rowRepo: Repository<SizeTableRow>,
    @InjectRepository(SizeTableCell)
    private readonly cellRepo: Repository<SizeTableCell>,
    @InjectRepository(CareGuide)
    private readonly careGuideRepo: Repository<CareGuide>,
    @InjectRepository(CareInstruction)
    private readonly instructionRepo: Repository<CareInstruction>,
    @InjectRepository(MeasurementGuide)
    private readonly measurementGuideRepo: Repository<MeasurementGuide>,
    @InjectRepository(MeasurementImage)
    private readonly measurementImageRepo: Repository<MeasurementImage>,
    @InjectRepository(CategoryGuideSetting)
    private readonly categorySettingRepo: Repository<CategoryGuideSetting>,
    @InjectRepository(ProductGuideSetting)
    private readonly productSettingRepo: Repository<ProductGuideSetting>,
    @InjectRepository(ProductGuideOverride)
    private readonly overrideRepo: Repository<ProductGuideOverride>,
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
    private readonly filesService: FilesService,
    private readonly dataSource: DataSource,
  ) {}

  // ============================================================
  // جدول سایزبندی
  // ============================================================

  async listSizeTables(query: QueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.sizeTableRepo.createQueryBuilder('table');

    applySearch(qb, query.search, ['table.name']);

    if (!query.includeArchived) {
      qb.andWhere('table.isArchived = false');
    }

    qb.orderBy('table.updatedAt', 'DESC').addOrderBy('table.id', 'DESC');

    if (query.all) {
      const data = await qb.getMany();
      const counts = await this.countSizeTableChildren(
        data.map(item => item.id),
      );

      return {
        data: data.map(table => this.sizeTableListItem(table, counts)),
      };
    }

    const { skip, take } = getPagination(page, limit);
    qb.skip(skip).take(take);

    const [rows, total] = await qb.getManyAndCount();

    const counts = await this.countSizeTableChildren(rows.map(item => item.id));

    return {
      data: rows.map(table => this.sizeTableListItem(table, counts)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getSizeTable(id: number) {
    const table = await this.findSizeTableEntity(id);

    return { data: this.toSizeTableDefinition(table) };
  }

  async createSizeTable(dto: UpsertSizeTableDto) {
    const table = await this.saveSizeTable(new SizeTable(), dto);

    return {
      message: 'جدول سایزبندی با موفقیت ساخته شد.',
      data: table,
      dependents: { categories: 0, products: 0 },
    };
  }

  async updateSizeTable(id: number, dto: UpsertSizeTableDto) {
    const table = await this.findSizeTableEntity(id);

    const warnings = await this.collectSizeTableRemovalWarnings(table, dto);

    const dependents = await this.countDependents(GuideType.SIZE_TABLE, id);

    const saved = await this.saveSizeTable(table, dto);

    return {
      message: 'جدول سایزبندی با موفقیت ذخیره شد.',
      data: saved,
      warnings,
      dependents,
    };
  }

  async duplicateSizeTable(id: number, name?: string) {
    const source = await this.findSizeTableEntity(id);

    const copy = await this.sizeTableRepo.save(
      this.sizeTableRepo.create({
        name: name ?? `${source.name} (کپی)`,
        unit: source.unit,
        notes: source.notes,
        isArchived: false,
      }),
    );

    const columnMap = new Map<number, SizeTableColumn>();

    for (const column of this.sortColumns(source.columns)) {
      const saved = await this.columnRepo.save(
        this.columnRepo.create({
          sizeTableId: copy.id,
          label: column.label,
          order: column.order,
        }),
      );

      columnMap.set(column.id, saved);
    }

    for (const row of this.sortRows(source.rows)) {
      const savedRow = await this.rowRepo.save(
        this.rowRepo.create({
          sizeTableId: copy.id,
          label: row.label,
          order: row.order,
        }),
      );

      for (const cell of row.cells ?? []) {
        const column = columnMap.get(cell.columnId);

        if (!column) continue;

        await this.cellRepo.save(
          this.cellRepo.create({
            rowId: savedRow.id,
            columnId: column.id,
            value: cell.value,
          }),
        );
      }
    }

    return {
      message: 'یک نسخه کپی از جدول سایزبندی ساخته شد.',
      data: { id: copy.id, name: copy.name },
    };
  }

  async setSizeTableArchived(id: number, isArchived: boolean) {
    const table = await this.findSizeTableEntity(id, { withRelations: false });

    table.isArchived = isArchived;
    await this.sizeTableRepo.save(table);

    return {
      message: isArchived
        ? 'جدول سایزبندی بایگانی شد.'
        : 'جدول سایزبندی از بایگانی خارج شد.',
      data: { id, isArchived },
    };
  }

  // ============================================================
  // راهنمای شست‌وشو
  // ============================================================

  async listCareGuides(query: QueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.careGuideRepo.createQueryBuilder('guide');

    applySearch(qb, query.search, ['guide.name']);

    if (!query.includeArchived) {
      qb.andWhere('guide.isArchived = false');
    }

    qb.orderBy('guide.updatedAt', 'DESC').addOrderBy('guide.id', 'DESC');

    if (query.all) {
      const data = await qb.getMany();
      const counts = await this.countCareInstructions(
        data.map(item => item.id),
      );

      return {
        data: data.map(guide => this.careGuideListItem(guide, counts)),
      };
    }

    const { skip, take } = getPagination(page, limit);
    qb.skip(skip).take(take);

    const [rows, total] = await qb.getManyAndCount();

    const counts = await this.countCareInstructions(rows.map(item => item.id));

    return {
      data: rows.map(guide => this.careGuideListItem(guide, counts)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getCareGuide(id: number) {
    const guide = await this.findCareGuideEntity(id);

    return { data: this.toCareGuideDefinition(guide) };
  }

  async createCareGuide(dto: UpsertCareGuideDto) {
    const guide = await this.saveCareGuide(new CareGuide(), dto);

    return {
      message: 'راهنمای شست‌وشو با موفقیت ساخته شد.',
      data: guide,
      dependents: { categories: 0, products: 0 },
    };
  }

  async updateCareGuide(id: number, dto: UpsertCareGuideDto) {
    const guide = await this.findCareGuideEntity(id);

    const keepIds = new Set(
      (dto.instructions ?? [])
        .map(instruction => instruction.id)
        .filter((value): value is number => Boolean(value)),
    );

    const removedIds = (guide.instructions ?? [])
      .map(instruction => instruction.id)
      .filter(instructionId => !keepIds.has(instructionId));

    const warnings = removedIds.length
      ? await this.collectInstructionRemovalWarnings(id, removedIds)
      : [];

    const dependents = await this.countDependents(GuideType.CARE_GUIDE, id);

    const saved = await this.saveCareGuide(guide, dto);

    return {
      message: 'راهنمای شست‌وشو با موفقیت ذخیره شد.',
      data: saved,
      warnings,
      dependents,
    };
  }

  async duplicateCareGuide(id: number, name?: string) {
    const source = await this.findCareGuideEntity(id);

    const copy = await this.careGuideRepo.save(
      this.careGuideRepo.create({
        name: name ?? `${source.name} (کپی)`,
        notes: source.notes,
        isArchived: false,
      }),
    );

    for (const instruction of this.sortInstructions(source.instructions)) {
      await this.instructionRepo.save(
        this.instructionRepo.create({
          careGuideId: copy.id,
          text: instruction.text,
          iconKey: instruction.iconKey,
          order: instruction.order,
        }),
      );
    }

    return {
      message: 'یک نسخه کپی از راهنمای شست‌وشو ساخته شد.',
      data: { id: copy.id, name: copy.name },
    };
  }

  async setCareGuideArchived(id: number, isArchived: boolean) {
    const guide = await this.findCareGuideEntity(id, { withRelations: false });

    guide.isArchived = isArchived;
    await this.careGuideRepo.save(guide);

    return {
      message: isArchived
        ? 'راهنمای شست‌وشو بایگانی شد.'
        : 'راهنمای شست‌وشو از بایگانی خارج شد.',
      data: { id, isArchived },
    };
  }

  // ============================================================
  // تصاویر روش اندازه‌گیری
  // ============================================================

  async listMeasurementGuides(query: QueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.measurementGuideRepo.createQueryBuilder('guide');

    applySearch(qb, query.search, ['guide.name']);

    if (!query.includeArchived) {
      qb.andWhere('guide.isArchived = false');
    }

    qb.orderBy('guide.updatedAt', 'DESC').addOrderBy('guide.id', 'DESC');

    if (query.all) {
      const data = await qb.getMany();
      const counts = await this.countMeasurementImages(
        data.map(item => item.id),
      );

      return {
        data: data.map(guide => this.measurementGuideListItem(guide, counts)),
      };
    }

    const { skip, take } = getPagination(page, limit);
    qb.skip(skip).take(take);

    const [rows, total] = await qb.getManyAndCount();

    const counts = await this.countMeasurementImages(rows.map(item => item.id));

    return {
      data: rows.map(guide => this.measurementGuideListItem(guide, counts)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getMeasurementGuide(id: number) {
    const guide = await this.findMeasurementGuideEntity(id);

    return { data: this.toMeasurementGuideDefinition(guide) };
  }

  async createMeasurementGuide(
    dto: UpsertMeasurementGuideDto,
    files: Express.Multer.File[] = [],
  ) {
    const validFiles = this.validateFiles(files);

    if (!validFiles.length) {
      throw new BadRequestException('حداقل یک تصویر باید بارگذاری شود.');
    }

    const guide = await this.measurementGuideRepo.save(
      this.measurementGuideRepo.create({
        name: dto.name,
        notes: normalizeText(dto.notes),
        isArchived: false,
      }),
    );

    await this.attachMeasurementImages(guide.id, validFiles, 0);

    return {
      message: 'راهنمای تصویری با موفقیت ساخته شد.',
      data: { id: guide.id, name: guide.name },
      dependents: { categories: 0, products: 0 },
    };
  }

  async updateMeasurementGuide(
    id: number,
    dto: UpsertMeasurementGuideDto,
    files: Express.Multer.File[] = [],
  ) {
    const guide = await this.findMeasurementGuideEntity(id);

    const existingIds = (guide.images ?? []).map(image => image.id);

    const keptIds = this.parseIdList(dto.keepImageIds).filter(imageId =>
      existingIds.includes(imageId),
    );

    const removed = (guide.images ?? []).filter(
      image => !keptIds.includes(image.id),
    );

    const validFiles = this.validateFiles(files);

    if (!keptIds.length && !validFiles.length) {
      throw new BadRequestException(
        'راهنمای تصویری باید حداقل یک تصویر داشته باشد.',
      );
    }

    const warnings = removed.length
      ? await this.collectImageRemovalWarnings(
          id,
          removed.map(image => image.id),
        )
      : [];

    const dependents = await this.countDependents(
      GuideType.MEASUREMENT_GUIDE,
      id,
    );

    guide.name = dto.name;
    guide.notes = normalizeText(dto.notes);

    await this.measurementGuideRepo.save(guide);

    /** ترتیب تصاویر باقی‌مانده مطابق ترتیبی که ادمین فرستاده */
    for (const [index, imageId] of keptIds.entries()) {
      await this.measurementImageRepo.update(imageId, { order: index });
    }

    await this.attachMeasurementImages(id, validFiles, keptIds.length);

    for (const image of removed) {
      await this.overrideRepo.delete({
        guideType: GuideType.MEASUREMENT_GUIDE,
        targetKey: `image:${image.id}`,
      });

      await this.measurementImageRepo.delete(image.id);

      this.filesService.deleteFile(image.file);
    }

    return {
      message: 'راهنمای تصویری با موفقیت ذخیره شد.',
      data: { id, name: guide.name },
      warnings,
      dependents,
    };
  }

  async duplicateMeasurementGuide(id: number, name?: string) {
    const source = await this.findMeasurementGuideEntity(id);

    const copy = await this.measurementGuideRepo.save(
      this.measurementGuideRepo.create({
        name: name ?? `${source.name} (کپی)`,
        notes: source.notes,
        isArchived: false,
      }),
    );

    for (const image of this.sortImages(source.images)) {
      await this.measurementImageRepo.save(
        this.measurementImageRepo.create({
          measurementGuideId: copy.id,
          file: image.file,
          caption: image.caption,
          order: image.order,
        }),
      );
    }

    return {
      message: 'یک نسخه کپی از راهنمای تصویری ساخته شد.',
      data: { id: copy.id, name: copy.name },
    };
  }

  async setMeasurementGuideArchived(id: number, isArchived: boolean) {
    const guide = await this.findMeasurementGuideEntity(id, {
      withRelations: false,
    });

    guide.isArchived = isArchived;
    await this.measurementGuideRepo.save(guide);

    return {
      message: isArchived
        ? 'راهنمای تصویری بایگانی شد.'
        : 'راهنمای تصویری از بایگانی خارج شد.',
      data: { id, isArchived },
    };
  }

  async updateMeasurementImage(
    guideId: number,
    imageId: number,
    data: { caption?: string | null; order?: number },
  ) {
    const image = await this.measurementImageRepo.findOne({
      where: { id: imageId, measurementGuideId: guideId },
    });

    if (!image) throw new NotFoundException('تصویر پیدا نشد.');

    if (data.caption !== undefined) {
      image.caption = normalizeText(data.caption);
    }

    if (data.order !== undefined) {
      image.order = data.order;
    }

    await this.measurementImageRepo.save(image);

    return {
      message: 'تصویر با موفقیت به‌روزرسانی شد.',
      data: { id: image.id, caption: image.caption, order: image.order },
    };
  }

  async reorderMeasurementImages(guideId: number, imageIds: number[]) {
    const guide = await this.findMeasurementGuideEntity(guideId, {
      withRelations: false,
    });

    for (const [index, imageId] of imageIds.entries()) {
      await this.measurementImageRepo.update(
        { id: imageId, measurementGuideId: guide.id },
        { order: index },
      );
    }

    return {
      message: 'ترتیب تصاویر ذخیره شد.',
      data: { id: guideId, imageIds },
    };
  }

  async deleteMeasurementImage(guideId: number, imageId: number) {
    const guide = await this.findMeasurementGuideEntity(guideId);

    if ((guide.images ?? []).length <= 1) {
      throw new BadRequestException(
        'راهنمای تصویری باید حداقل یک تصویر داشته باشد؛ برای حذف کامل، خود راهنما را حذف کنید.',
      );
    }

    const image = (guide.images ?? []).find(item => item.id === imageId);

    if (!image) throw new NotFoundException('تصویر پیدا نشد.');

    const warnings = await this.collectImageRemovalWarnings(guideId, [imageId]);

    await this.overrideRepo.delete({
      guideType: GuideType.MEASUREMENT_GUIDE,
      targetKey: `image:${imageId}`,
    });

    await this.measurementImageRepo.delete(imageId);

    this.filesService.deleteFile(image.file);

    return {
      message: 'تصویر حذف شد.',
      data: { id: imageId },
      warnings,
    };
  }

  // ============================================================
  // کاربرد راهنما و حذف
  // ============================================================

  async getGuideUsage(type: GuideType, id: number) {
    await this.findGuideEntity(type, id, { withRelations: false });

    const [categories, directProducts, overrideProducts] = await Promise.all([
      this.findAssignedCategories(type, id),
      this.findAssignedProducts(type, id),
      this.findOverrideProducts(type, id),
    ]);

    const productsByCategory = await this.findProductsOfCategories(
      categories.map(category => category.id),
    );

    const directIds = new Set(directProducts.map(product => product.id));

    const productsFromCategory = productsByCategory
      .filter(product => !directIds.has(product.id))
      .map(product => ({ id: product.id, title: product.title }));

    return {
      data: {
        type,
        guideId: id,
        categories,
        directProducts,
        productsByCategory: productsFromCategory,
        totalProducts: directProducts.length + productsFromCategory.length,
        overrides: {
          productCount: overrideProducts.length,
          overrideCount: overrideProducts.reduce(
            (sum, product) => sum + product.count,
            0,
          ),
          items: overrideProducts,
        },
      },
    };
  }

  async countDependents(type: GuideType, id: number) {
    const usage = (await this.getGuideUsage(type, id)).data;

    return {
      categories: usage.categories.length,
      products: usage.totalProducts,
      overridingProducts: usage.overrides.productCount,
    };
  }

  /**
   * حذف راهنما
   *
   * اگر راهنما به دسته یا محصولی متصل باشد، بدون `replaceWithId` یا `force`
   * حذف انجام نمی‌شود تا ادمین ابتدا کاربردها را ببیند.
   */
  async deleteGuide(
    type: GuideType,
    id: number,
    options: { replaceWithId?: number; force?: boolean } = {},
  ) {
    const guide = await this.findGuideEntity(type, id, {
      withRelations: false,
    });

    if (options.replaceWithId) {
      await this.findGuideEntity(type, options.replaceWithId, {
        withRelations: false,
      });
    }

    const usage = (await this.getGuideUsage(type, id)).data;

    const hasUsage = usage.categories.length > 0 || usage.totalProducts > 0;

    if (hasUsage && !options.replaceWithId && !options.force) {
      throw new BadRequestException(
        `این راهنما در ${usage.categories.length} دسته و ${usage.totalProducts} محصول استفاده شده است. ` +
          'ابتدا راهنمای جانشین را انتخاب کنید یا حذف را تأیید کنید.',
      );
    }

    const imageFiles =
      type === GuideType.MEASUREMENT_GUIDE
        ? (await this.findMeasurementGuideEntity(id)).images.map(
            image => image.file,
          )
        : [];

    const replacementId = options.replaceWithId ?? null;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const guideColumn = GUIDE_COLUMNS[type];

      /** دسته‌ها → راهنمای جانشین یا پاک‌کردن اتصال */
      for (const category of usage.categories) {
        await queryRunner.manager.update(
          CategoryGuideSetting,
          category.settingId,
          {
            [guideColumn]: replacementId,
          },
        );
      }

      /** محصولات با انتخاب مستقیم → جانشین یا بازگشت به راهنمای دسته */
      for (const product of usage.directProducts) {
        await queryRunner.manager.update(
          ProductGuideSetting,
          (product as any).settingId,
          replacementId
            ? {
                [guideColumn]: replacementId,
                [MODE_COLUMNS[type]]: GuideMode.CUSTOM,
              }
            : { [guideColumn]: null, [MODE_COLUMNS[type]]: GuideMode.INHERIT },
        );
      }

      /** تغییرات اختصاصی روی همین راهنما → انتقال به جانشین */
      if (replacementId) {
        await queryRunner.manager.update(
          ProductGuideOverride,
          { guideType: type, baseGuideId: id },
          { baseGuideId: replacementId },
        );
      }

      await queryRunner.manager.delete(
        this.entityTargetByType(type),
        (guide as { id: number }).id,
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();

      throw error;
    } finally {
      await queryRunner.release();
    }

    for (const file of imageFiles) {
      this.filesService.deleteFile(file);
    }

    this.logger.log(
      `🗑️ راهنما ${type}#${id} حذف شد` +
        (replacementId
          ? ` و اتصال‌ها به راهنمای ${replacementId} منتقل شد.`
          : ' (بدون جانشین).'),
    );

    return {
      message: replacementId
        ? 'راهنما حذف و اتصال‌ها به راهنمای جانشین منتقل شد.'
        : 'راهنما حذف شد.',
      data: {
        removed: { type, guideId: id },
        previousUsage: {
          categories: usage.categories.length,
          products: usage.totalProducts,
          overridingProducts: usage.overrides.productCount,
        },
        replacedWith: replacementId,
      },
    };
  }

  // ============================================================
  // اختصاص گروهی به دسته‌ها و محصولات
  // ============================================================

  async previewAssignment(dto: AssignGuidesDto) {
    const categoryIds = [...new Set(dto.categoryIds ?? [])];
    const productIds = [...new Set(dto.productIds ?? [])];

    const [categories, directProducts, currentSettings] = await Promise.all([
      categoryIds.length
        ? this.categoryRepo.find({ where: { id: In(categoryIds) } })
        : Promise.resolve([]),
      productIds.length
        ? this.productRepo.find({
            where: { id: In(productIds) },
            relations: { categories: true },
          })
        : Promise.resolve([]),
      this.loadCategorySettings(categoryIds),
    ]);

    const productsByCategory = await this.findProductsOfCategories(
      categoryIds,
      {
        withCategories: true,
      },
    );

    const affectedMap = new Map<number, Product>();

    for (const product of [...productsByCategory, ...directProducts]) {
      affectedMap.set(product.id, product);
    }

    const affectedProducts = [...affectedMap.values()];

    /** نتیجه پیش‌بینی‌شده تنظیمات دسته‌ها */
    const nextByCategory = new Map<
      number,
      {
        sizeTableId: number | null;
        careGuideId: number | null;
        measurementGuideId: number | null;
      }
    >();

    for (const categoryId of categoryIds) {
      const current = currentSettings.get(categoryId);

      nextByCategory.set(categoryId, {
        sizeTableId: this.mergeValue(
          dto.sizeTableId,
          current?.sizeTableId ?? null,
        ),
        careGuideId: this.mergeValue(
          dto.careGuideId,
          current?.careGuideId ?? null,
        ),
        measurementGuideId: this.mergeValue(
          dto.measurementGuideId,
          current?.measurementGuideId ?? null,
        ),
      });
    }

    const allCategoryIds = affectedProducts.flatMap(product =>
      (product.categories ?? []).map(category => category.id),
    );

    const [categorySettingsMap, productSettings, overridesCount] =
      await Promise.all([
        this.loadCategorySettings(allCategoryIds),
        this.loadProductSettings(affectedProducts.map(product => product.id)),
        this.countOverridesForProducts(
          affectedProducts.map(product => product.id),
        ),
      ]);

    const conflicts: {
      productId: number;
      productTitle: string;
      type: GuideType;
      guideIds: number[];
      categories: { id: number; name: string; guideId: number }[];
    }[] = [];

    const explicitChoices: {
      productId: number;
      productTitle: string;
      type: GuideType;
    }[] = [];

    for (const product of affectedProducts) {
      const setting = productSettings.get(product.id);

      for (const type of Object.values(GuideType)) {
        const mode = setting
          ? this.modeOfSetting(type, setting)
          : GuideMode.INHERIT;

        if (mode !== GuideMode.INHERIT) {
          if (mode === GuideMode.CUSTOM) {
            explicitChoices.push({
              productId: product.id,
              productTitle: product.title,
              type,
            });
          }

          continue;
        }

        const ids = new Map<
          number,
          { id: number; name: string; guideId: number }
        >();

        for (const category of product.categories ?? []) {
          const projected =
            nextByCategory.get(category.id) ??
            this.settingToPlain(categorySettingsMap.get(category.id));

          const guideId = projected
            ? ((projected as any)[GUIDE_COLUMNS[type]] ?? null)
            : null;

          if (!guideId) continue;

          ids.set(guideId, {
            id: category.id,
            name: category.name,
            guideId,
          });
        }

        if (ids.size > 1) {
          conflicts.push({
            productId: product.id,
            productTitle: product.title,
            type,
            guideIds: [...ids.keys()],
            categories: [...ids.values()],
          });
        }
      }
    }

    return {
      message: 'پیش‌نمایش اختصاص راهنما',
      data: {
        categories: categories.map(category => ({
          id: category.id,
          name: category.name,
          current: this.settingToPlain(currentSettings.get(category.id)),
        })),
        directProducts: directProducts.map(product => ({
          id: product.id,
          title: product.title,
          categoryCount: product.categories?.length ?? 0,
        })),
        selectedCategoryCount: categories.length,
        selectedProductCount: directProducts.length,
        affectedProductCount: affectedProducts.length,
        affectedProducts: affectedProducts.slice(0, 100).map(product => ({
          id: product.id,
          title: product.title,
          categoryCount: product.categories?.length ?? 0,
          overrideCount: overridesCount.get(product.id) ?? 0,
        })),
        conflicts,
        explicitChoices,
        next: {
          sizeTableId: dto.sizeTableId,
          careGuideId: dto.careGuideId,
          measurementGuideId: dto.measurementGuideId,
        },
      },
    };
  }

  async applyAssignment(dto: AssignGuidesDto) {
    const preview = await this.previewAssignment(dto);

    for (const categoryId of dto.categoryIds ?? []) {
      let setting = await this.categorySettingRepo.findOne({
        where: { categoryId },
      });

      if (!setting) setting = this.categorySettingRepo.create({ categoryId });

      if (dto.sizeTableId !== undefined) setting.sizeTableId = dto.sizeTableId;

      if (dto.careGuideId !== undefined) setting.careGuideId = dto.careGuideId;

      if (dto.measurementGuideId !== undefined) {
        setting.measurementGuideId = dto.measurementGuideId;
      }

      await this.categorySettingRepo.save(setting);
    }

    for (const productId of dto.productIds ?? []) {
      let setting = await this.productSettingRepo.findOne({
        where: { productId },
      });

      if (!setting) setting = this.productSettingRepo.create({ productId });

      this.applyProductSettingField(
        setting,
        GuideType.SIZE_TABLE,
        dto.sizeTableId,
      );
      this.applyProductSettingField(
        setting,
        GuideType.CARE_GUIDE,
        dto.careGuideId,
      );
      this.applyProductSettingField(
        setting,
        GuideType.MEASUREMENT_GUIDE,
        dto.measurementGuideId,
      );

      await this.productSettingRepo.save(setting);
    }

    this.logger.log(
      `🧭 اختصاص راهنما به ${(dto.categoryIds ?? []).length} دسته و ` +
        `${(dto.productIds ?? []).length} محصول انجام شد.`,
    );

    return {
      message: 'راهنما با موفقیت اختصاص داده شد.',
      data: preview.data,
    };
  }

  // ============================================================
  // تنظیمات و استثناهای محصول
  // ============================================================

  async getProductGuideState(productId: number) {
    const product = await this.findProduct(productId);

    const { resolved, setting, overrides } = await this.resolveProduct(product);

    return {
      data: {
        product: {
          id: product.id,
          title: product.title,
          slug: product.slug,
          categories: (product.categories ?? []).map(category => ({
            id: category.id,
            name: category.name,
          })),
        },
        setting: setting
          ? {
              sizeTableMode: setting.sizeTableMode,
              sizeTableId: setting.sizeTableId,
              careGuideMode: setting.careGuideMode,
              careGuideId: setting.careGuideId,
              measurementGuideMode: setting.measurementGuideMode,
              measurementGuideId: setting.measurementGuideId,
            }
          : null,
        overrides: overrides.map(override => ({
          id: override.id,
          guideType: override.guideType,
          action: override.action,
          targetKey: override.targetKey,
          value: override.value,
          baseGuideId: override.baseGuideId,
        })),
        resolved,
      },
    };
  }

  async upsertProductSetting(dto: UpsertProductGuideSettingDto) {
    const product = await this.findProduct(dto.productId, false);

    let setting = await this.productSettingRepo.findOne({
      where: { productId: dto.productId },
    });

    if (!setting) {
      setting = this.productSettingRepo.create({ productId: dto.productId });
    }

    if (dto.sizeTableMode !== undefined)
      setting.sizeTableMode = dto.sizeTableMode;

    if (dto.sizeTableId !== undefined) setting.sizeTableId = dto.sizeTableId;

    if (dto.careGuideMode !== undefined)
      setting.careGuideMode = dto.careGuideMode;

    if (dto.careGuideId !== undefined) setting.careGuideId = dto.careGuideId;

    if (dto.measurementGuideMode !== undefined) {
      setting.measurementGuideMode = dto.measurementGuideMode;
    }

    if (dto.measurementGuideId !== undefined) {
      setting.measurementGuideId = dto.measurementGuideId;
    }

    await this.productSettingRepo.save(setting);

    this.logger.log(`🧭 تنظیم راهنمای محصول ${product.id} به‌روزرسانی شد.`);

    return this.getProductGuideState(dto.productId);
  }

  async upsertProductOverride(
    productId: number,
    dto: UpsertProductOverrideDto,
  ) {
    const product = await this.findProduct(productId);

    const { resolved } = await this.resolveProduct(product);

    const currentGuideId = this.resolvedGuideIdByType(resolved, dto.guideType);

    if (!currentGuideId) {
      throw new BadRequestException(
        'برای این محصول در این بخش راهنمایی فعال نیست؛ ابتدا راهنما را انتخاب کنید.',
      );
    }

    let override = await this.overrideRepo.findOne({
      where: {
        productId,
        guideType: dto.guideType,
        targetKey: dto.targetKey,
      },
    });

    if (!override) {
      override = this.overrideRepo.create({
        productId,
        guideType: dto.guideType,
        targetKey: dto.targetKey,
      });
    }

    override.action = dto.action;

    override.value =
      dto.action === GuideOverrideAction.CELL_VALUE
        ? normalizeCellValue(dto.value)
        : normalizeText(dto.value);

    override.baseGuideId = dto.baseGuideId ?? currentGuideId;

    await this.overrideRepo.save(override);

    return this.getProductGuideState(productId);
  }

  async deleteProductOverride(productId: number, overrideId: number) {
    const override = await this.overrideRepo.findOne({
      where: { id: overrideId, productId },
    });

    if (!override) throw new NotFoundException('تغییر اختصاصی پیدا نشد.');

    await this.overrideRepo.delete(overrideId);

    return this.getProductGuideState(productId);
  }

  /**
   * «بازگشت به راهنمای اصلی»
   *
   * راهنمای فعلی دسته/محصول به‌عنوان پایه جدید ثبت می‌شود؛ یعنی این مقدار
   * دوباره از راهنمای جاری خوانده می‌شود و تغییر اختصاصی حذف می‌شود.
   */
  async rebaseProductOverride(productId: number, overrideId: number) {
    const override = await this.overrideRepo.findOne({
      where: { id: overrideId, productId },
    });

    if (!override) throw new NotFoundException('تغییر اختصاصی پیدا نشد.');

    const product = await this.findProduct(productId);

    const { resolved } = await this.resolveProduct(product);

    const currentGuideId = this.resolvedGuideIdByType(
      resolved,
      override.guideType,
    );

    if (!currentGuideId) {
      throw new BadRequestException(
        'راهنمای فعلی این بخش در دسترس نیست؛ ابتدا راهنما را انتخاب کنید.',
      );
    }

    override.baseGuideId = currentGuideId;

    await this.overrideRepo.save(override);

    return this.getProductGuideState(productId);
  }

  async clearProductOverrides(
    productId: number,
    options: { onlyPending?: boolean } = {},
  ) {
    if (!options.onlyPending) {
      await this.overrideRepo.delete({ productId });

      return this.getProductGuideState(productId);
    }

    const product = await this.findProduct(productId);

    const { resolved } = await this.resolveProduct(product);

    const ids = [
      ...resolved.staleOverrides.map(item => item.id),
      ...resolved.pendingReview.map(item => item.id),
    ];

    if (ids.length) {
      await this.overrideRepo.delete({ id: In(ids), productId });
    }

    return this.getProductGuideState(productId);
  }

  // ============================================================
  // نمایش برای مشتری
  // ============================================================

  async getPublicGuidesByProductId(productId: number) {
    const product = await this.findProduct(productId, false);

    return { data: await this.buildPublicGuides(product) };
  }

  async getPublicGuidesByProductSlug(slug: string) {
    const product = await this.productRepo.findOne({
      where: { slug },
      relations: { categories: true },
    });

    if (!product) throw new NotFoundException('محصول پیدا نشد.');

    return { data: await this.buildPublicGuides(product) };
  }

  private async buildPublicGuides(product: Product) {
    const { resolved } = await this.resolveProduct(product);

    /**
     * فقط اطلاعات نهایی برای مشتری: راهنمای مشترک + تغییرات اختصاصی همان محصول.
     * تعارض چنددسته‌ای هم نمایش داده نمی‌شود تا سیستم تصادفی یکی را انتخاب نکند.
     */
    return {
      sizeTable: resolved.sizeTable
        ? {
            id: resolved.sizeTable.id,
            name: resolved.sizeTable.name,
            unit: resolved.sizeTable.unit,
            notes: resolved.sizeTable.notes,
            columns: resolved.sizeTable.columns.map(column => ({
              id: column.id,
              label: column.label,
            })),
            rows: resolved.sizeTable.rows.map(row => ({
              id: row.id,
              label: row.label,
              values: row.values.map(value => ({
                columnId: value.columnId,
                value: value.value,
              })),
            })),
          }
        : null,
      careGuide: resolved.careGuide
        ? {
            id: resolved.careGuide.id,
            name: resolved.careGuide.name,
            notes: resolved.careGuide.notes,
            instructions: resolved.careGuide.instructions.map(instruction => ({
              id: instruction.id,
              text: instruction.text,
              iconKey: instruction.iconKey,
            })),
          }
        : null,
      measurementGuide: resolved.measurementGuide
        ? {
            id: resolved.measurementGuide.id,
            name: resolved.measurementGuide.name,
            notes: resolved.measurementGuide.notes,
            images: resolved.measurementGuide.images.map(image => ({
              id: image.id,
              file: image.file,
              caption: image.caption,
            })),
          }
        : null,
    };
  }

  // ============================================================
  // حل راهنما برای یک محصول
  // ============================================================

  private async resolveProduct(product: Product) {
    const categoryIds = (product.categories ?? []).map(category => category.id);

    const [categorySettings, setting, overrides] = await Promise.all([
      this.loadCategorySettings(categoryIds),
      this.productSettingRepo.findOne({ where: { productId: product.id } }),
      this.overrideRepo.find({ where: { productId: product.id } }),
    ]);

    const overrideRecords = overrides.map(override => ({
      id: override.id,
      guideType: override.guideType,
      action: override.action,
      targetKey: override.targetKey,
      value: override.value,
      baseGuideId: override.baseGuideId,
    }));

    const candidateIds: Record<GuideType, Set<number>> = {
      [GuideType.SIZE_TABLE]: new Set<number>(),
      [GuideType.CARE_GUIDE]: new Set<number>(),
      [GuideType.MEASUREMENT_GUIDE]: new Set<number>(),
    };

    for (const categorySetting of categorySettings.values()) {
      for (const type of Object.values(GuideType)) {
        const guideId = this.guideIdOfSetting(type, categorySetting);

        if (guideId) candidateIds[type].add(guideId);
      }
    }

    if (setting) {
      for (const type of Object.values(GuideType)) {
        if (this.modeOfSetting(type, setting) !== GuideMode.CUSTOM) continue;

        const guideId = this.guideIdOfSetting(type, setting);

        if (guideId) candidateIds[type].add(guideId);
      }
    }

    /** راهنمای پایه تغییرهای اختصاصی هم باید بارگذاری شود تا هشدار بدهیم */
    for (const override of overrideRecords) {
      if (override.baseGuideId) {
        candidateIds[override.guideType].add(override.baseGuideId);
      }
    }

    const [sizeTables, careGuides, measurementGuides] = await Promise.all([
      this.loadSizeTableDefinitions([...candidateIds[GuideType.SIZE_TABLE]]),
      this.loadCareGuideDefinitions([...candidateIds[GuideType.CARE_GUIDE]]),
      this.loadMeasurementGuideDefinitions([
        ...candidateIds[GuideType.MEASUREMENT_GUIDE],
      ]),
    ]);

    const replacementImageIds = overrideRecords
      .filter(
        override =>
          override.guideType === GuideType.MEASUREMENT_GUIDE &&
          override.action === GuideOverrideAction.REPLACE_IMAGE &&
          override.value,
      )
      .map(override => Number(override.value))
      .filter(id => Number.isFinite(id));

    const measurementImages = replacementImageIds.length
      ? await this.measurementImageRepo.find({
          where: { id: In(replacementImageIds) },
        })
      : [];

    const input: ResolveProductGuidesInput = {
      categories: this.buildCategoryCandidates(product, categorySettings),
      setting: setting
        ? {
            sizeTableMode: setting.sizeTableMode,
            sizeTableId: setting.sizeTableId,
            careGuideMode: setting.careGuideMode,
            careGuideId: setting.careGuideId,
            measurementGuideMode: setting.measurementGuideMode,
            measurementGuideId: setting.measurementGuideId,
          }
        : null,
      sizeTables,
      careGuides,
      measurementGuides,
      measurementImages: measurementImages.map(image => ({
        id: image.id,
        file: image.file,
        caption: image.caption,
      })),
      overrides: overrideRecords,
    };

    return { resolved: resolveProductGuides(input), setting, overrides };
  }

  private buildCategoryCandidates(
    product: Product,
    categorySettings: Map<number, CategoryGuideSetting>,
  ): CategoryGuideCandidate[] {
    return (product.categories ?? []).map(category => {
      const setting = categorySettings.get(category.id);

      return {
        categoryId: category.id,
        categoryName: category.name,
        sizeTableId: setting?.sizeTableId ?? null,
        careGuideId: setting?.careGuideId ?? null,
        measurementGuideId: setting?.measurementGuideId ?? null,
      };
    });
  }

  private resolvedGuideIdByType(
    resolved: ResolvedProductGuides,
    type: GuideType,
  ): number | null {
    if (type === GuideType.SIZE_TABLE) return resolved.sizeTable?.id ?? null;
    if (type === GuideType.CARE_GUIDE) return resolved.careGuide?.id ?? null;

    return resolved.measurementGuide?.id ?? null;
  }

  // ============================================================
  // ذخیره ساختارها
  // ============================================================

  private async saveSizeTable(table: SizeTable, dto: UpsertSizeTableDto) {
    const columns = dto.columns ?? [];

    if (!columns.length) {
      throw new BadRequestException('حداقل یک سایز باید به جدول اضافه شود.');
    }

    table.name = dto.name.trim();
    table.unit = dto.unit?.trim() || 'سانتیمتر';
    table.notes = normalizeText(dto.notes);

    const savedTable = await this.sizeTableRepo.save(table);

    const existingColumns = await this.columnRepo.find({
      where: { sizeTableId: savedTable.id },
    });

    const keptColumnIds = new Set<number>();
    const columnByIndex: SizeTableColumn[] = [];

    for (const [index, columnDto] of columns.entries()) {
      const existing = columnDto.id
        ? existingColumns.find(column => column.id === columnDto.id)
        : undefined;

      const column = existing
        ? await this.columnRepo.save(
            Object.assign(existing, {
              label: columnDto.label.trim(),
              order: index,
            }),
          )
        : await this.columnRepo.save(
            this.columnRepo.create({
              sizeTableId: savedTable.id,
              label: columnDto.label.trim(),
              order: index,
            }),
          );

      columnByIndex.push(column);
      keptColumnIds.add(column.id);
    }

    const existingRows = await this.rowRepo.find({
      where: { sizeTableId: savedTable.id },
      relations: { cells: true },
    });

    const keptRowIds = new Set<number>();

    for (const [index, rowDto] of (dto.rows ?? []).entries()) {
      const existing = rowDto.id
        ? existingRows.find(row => row.id === rowDto.id)
        : undefined;

      const row = existing
        ? await this.rowRepo.save(
            Object.assign(existing, {
              label: rowDto.label.trim(),
              order: index,
            }),
          )
        : await this.rowRepo.save(
            this.rowRepo.create({
              sizeTableId: savedTable.id,
              label: rowDto.label.trim(),
              order: index,
            }),
          );

      keptRowIds.add(row.id);

      const existingCells = row.cells ?? [];

      for (const [columnIndex, column] of columnByIndex.entries()) {
        const value = normalizeCellValue(rowDto.values?.[columnIndex] ?? null);

        const cell = existingCells.find(item => item.columnId === column.id);

        if (cell) {
          if (cell.value !== value) {
            cell.value = value;
            await this.cellRepo.save(cell);
          }

          continue;
        }

        if (value !== null) {
          await this.cellRepo.save(
            this.cellRepo.create({
              rowId: row.id,
              columnId: column.id,
              value,
            }),
          );
        }
      }
    }

    /** حذف ردیف/ستون‌هایی که در پنل حذف شده‌اند */
    for (const column of existingColumns) {
      if (keptColumnIds.has(column.id)) continue;

      await this.cellRepo.delete({ columnId: column.id });
      await this.columnRepo.delete(column.id);
    }

    for (const row of existingRows) {
      if (keptRowIds.has(row.id)) continue;

      await this.cellRepo.delete({ rowId: row.id });
      await this.rowRepo.delete(row.id);
    }

    const refreshed = await this.findSizeTableEntity(savedTable.id);

    return this.toSizeTableDefinition(refreshed);
  }

  private async saveCareGuide(guide: CareGuide, dto: UpsertCareGuideDto) {
    guide.name = dto.name.trim();
    guide.notes = normalizeText(dto.notes);

    const savedGuide = await this.careGuideRepo.save(guide);

    const existing = await this.instructionRepo.find({
      where: { careGuideId: savedGuide.id },
    });

    const keptIds = new Set<number>();

    for (const [index, instructionDto] of (dto.instructions ?? []).entries()) {
      const payload = {
        text: instructionDto.text.trim(),
        iconKey: normalizeText(instructionDto.iconKey),
        order: index,
      };

      const current = instructionDto.id
        ? existing.find(item => item.id === instructionDto.id)
        : undefined;

      if (current) {
        await this.instructionRepo.save(Object.assign(current, payload));
        keptIds.add(current.id);

        continue;
      }

      const created = await this.instructionRepo.save(
        this.instructionRepo.create({ careGuideId: savedGuide.id, ...payload }),
      );

      keptIds.add(created.id);
    }

    for (const instruction of existing) {
      if (keptIds.has(instruction.id)) continue;

      /** تغییرهای اختصاصی مربوط به دستور حذف‌شده هم پاک می‌شوند */
      await this.overrideRepo.delete({
        guideType: GuideType.CARE_GUIDE,
        targetKey: `instruction:${instruction.id}`,
      });

      await this.instructionRepo.delete(instruction.id);
    }

    const refreshed = await this.findCareGuideEntity(savedGuide.id);

    return this.toCareGuideDefinition(refreshed);
  }

  // ============================================================
  // هشدارهای حذف ردیف/ستون/دستور/تصویر
  // ============================================================

  private async collectSizeTableRemovalWarnings(
    table: SizeTable,
    dto: UpsertSizeTableDto,
  ) {
    const keepColumnIds = new Set(
      (dto.columns ?? [])
        .map(column => column.id)
        .filter((id): id is number => Boolean(id)),
    );

    const keepRowIds = new Set(
      (dto.rows ?? [])
        .map(row => row.id)
        .filter((id): id is number => Boolean(id)),
    );

    const warnings: string[] = [];

    for (const column of (table.columns ?? []).filter(
      item => !keepColumnIds.has(item.id),
    )) {
      const count = await this.overrideRepo
        .createQueryBuilder('override')
        .where('override.guide_type = :type', { type: GuideType.SIZE_TABLE })
        .andWhere(
          '(override.target_key = :key OR override.target_key LIKE :cellKey)',
          { key: `column:${column.id}`, cellKey: `cell:%:${column.id}` },
        )
        .getCount();

      if (count) {
        warnings.push(
          `ستون «${column.label}» در ${count} تغییر اختصاصی محصولات استفاده شده است؛ آن تغییرها نیاز به بازبینی دارند.`,
        );
      }
    }

    for (const row of (table.rows ?? []).filter(
      item => !keepRowIds.has(item.id),
    )) {
      const count = await this.overrideRepo
        .createQueryBuilder('override')
        .where('override.guide_type = :type', { type: GuideType.SIZE_TABLE })
        .andWhere(
          '(override.target_key = :key OR override.target_key LIKE :cellKey)',
          { key: `row:${row.id}`, cellKey: `cell:${row.id}:%` },
        )
        .getCount();

      if (count) {
        warnings.push(
          `ردیف «${row.label}» در ${count} تغییر اختصاصی محصولات استفاده شده است؛ آن تغییرها نیاز به بازبینی دارند.`,
        );
      }
    }

    return warnings;
  }

  private async collectInstructionRemovalWarnings(
    guideId: number,
    instructionIds: number[],
  ) {
    const count = await this.overrideRepo
      .createQueryBuilder('override')
      .where('override.guide_type = :type', { type: GuideType.CARE_GUIDE })
      .andWhere('override.base_guide_id = :guideId', { guideId })
      .andWhere('override.target_key IN (:...keys)', {
        keys: instructionIds.map(id => `instruction:${id}`),
      })
      .getCount();

    return count
      ? [
          `${count} تغییر اختصاصی محصولات به دستورهای حذف‌شده وابسته بود و پاک شد.`,
        ]
      : [];
  }

  private async collectImageRemovalWarnings(
    guideId: number,
    imageIds: number[],
  ) {
    const count = await this.overrideRepo
      .createQueryBuilder('override')
      .where('override.guide_type = :type', {
        type: GuideType.MEASUREMENT_GUIDE,
      })
      .andWhere('override.base_guide_id = :guideId', { guideId })
      .andWhere('override.target_key IN (:...keys)', {
        keys: imageIds.map(id => `image:${id}`),
      })
      .getCount();

    return count
      ? [
          `${count} تغییر اختصاصی محصولات به تصاویر حذف‌شده وابسته بود و پاک شد.`,
        ]
      : [];
  }

  // ============================================================
  // بارگذاری و ساخت خروجی
  // ============================================================

  private async findSizeTableEntity(
    id: number,
    options: { withRelations?: boolean } = { withRelations: true },
  ) {
    const table = await this.sizeTableRepo.findOne({
      where: { id },
      relations:
        options.withRelations === false
          ? undefined
          : { columns: true, rows: { cells: true } },
    });

    if (!table) throw new NotFoundException('جدول سایزبندی پیدا نشد.');

    return table;
  }

  private async findCareGuideEntity(
    id: number,
    options: { withRelations?: boolean } = { withRelations: true },
  ) {
    const guide = await this.careGuideRepo.findOne({
      where: { id },
      relations:
        options.withRelations === false ? undefined : { instructions: true },
    });

    if (!guide) throw new NotFoundException('راهنمای شست‌وشو پیدا نشد.');

    return guide;
  }

  private async findMeasurementGuideEntity(
    id: number,
    options: { withRelations?: boolean } = { withRelations: true },
  ) {
    const guide = await this.measurementGuideRepo.findOne({
      where: { id },
      relations: options.withRelations === false ? undefined : { images: true },
    });

    if (!guide) throw new NotFoundException('راهنمای تصویری پیدا نشد.');

    return guide;
  }

  private async findGuideEntity(
    type: GuideType,
    id: number,
    options: { withRelations?: boolean } = { withRelations: true },
  ) {
    if (type === GuideType.SIZE_TABLE) {
      return this.findSizeTableEntity(id, options);
    }

    if (type === GuideType.CARE_GUIDE) {
      return this.findCareGuideEntity(id, options);
    }

    return this.findMeasurementGuideEntity(id, options);
  }

  private async findProduct(id: number, withCategories = true) {
    const product = await this.productRepo.findOne({
      where: { id },
      relations: withCategories ? { categories: true } : undefined,
    });

    if (!product) throw new NotFoundException('محصول پیدا نشد.');

    return product;
  }

  private async loadSizeTableDefinitions(ids: number[]) {
    const unique = [...new Set(ids)].filter(Boolean);

    if (!unique.length) return [];

    const tables = await this.sizeTableRepo.find({
      where: { id: In(unique) },
      relations: { columns: true, rows: { cells: true } },
    });

    return tables.map(table => this.toSizeTableDefinition(table));
  }

  private async loadCareGuideDefinitions(ids: number[]) {
    const unique = [...new Set(ids)].filter(Boolean);

    if (!unique.length) return [];

    const guides = await this.careGuideRepo.find({
      where: { id: In(unique) },
      relations: { instructions: true },
    });

    return guides.map(guide => this.toCareGuideDefinition(guide));
  }

  private async loadMeasurementGuideDefinitions(ids: number[]) {
    const unique = [...new Set(ids)].filter(Boolean);

    if (!unique.length) return [];

    const guides = await this.measurementGuideRepo.find({
      where: { id: In(unique) },
      relations: { images: true },
    });

    return guides.map(guide => this.toMeasurementGuideDefinition(guide));
  }

  private async loadCategorySettings(categoryIds: number[]) {
    const unique = [...new Set(categoryIds)].filter(Boolean);

    if (!unique.length) return new Map<number, CategoryGuideSetting>();

    const settings = await this.categorySettingRepo.find({
      where: { categoryId: In(unique) },
    });

    return new Map(settings.map(setting => [setting.categoryId, setting]));
  }

  private async loadProductSettings(productIds: number[]) {
    const unique = [...new Set(productIds)].filter(Boolean);

    if (!unique.length) return new Map<number, ProductGuideSetting>();

    const settings = await this.productSettingRepo.find({
      where: { productId: In(unique) },
    });

    return new Map(settings.map(setting => [setting.productId, setting]));
  }

  private async findAssignedCategories(type: GuideType, id: number) {
    const settings = await this.categorySettingRepo.find({
      where: { [GUIDE_COLUMNS[type]]: id },
      relations: { category: true },
    });

    return settings.map(setting => ({
      settingId: setting.id,
      id: setting.categoryId,
      name: setting.category?.name ?? `دسته ${setting.categoryId}`,
    }));
  }

  private async findAssignedProducts(type: GuideType, id: number) {
    const settings = await this.productSettingRepo.find({
      where: { [GUIDE_COLUMNS[type]]: id },
      relations: { product: { categories: true } },
    });

    return settings.map(setting => ({
      settingId: setting.id,
      id: setting.productId,
      title: setting.product?.title ?? `محصول ${setting.productId}`,
      categories: (setting.product?.categories ?? []).map(category => ({
        id: category.id,
        name: category.name,
      })),
    }));
  }

  private async findOverrideProducts(type: GuideType, id: number) {
    const overrides = await this.overrideRepo.find({
      where: { guideType: type, baseGuideId: id },
      relations: { product: true },
    });

    const map = new Map<number, { id: number; title: string; count: number }>();

    for (const override of overrides) {
      const existing = map.get(override.productId);

      if (existing) {
        existing.count += 1;

        continue;
      }

      map.set(override.productId, {
        id: override.productId,
        title: override.product?.title ?? `محصول ${override.productId}`,
        count: 1,
      });
    }

    return [...map.values()];
  }

  private async findProductsOfCategories(
    categoryIds: number[],
    options: { withCategories?: boolean } = {},
  ) {
    const unique = [...new Set(categoryIds)].filter(Boolean);

    if (!unique.length) return [];

    const qb = this.productRepo
      .createQueryBuilder('product')
      .innerJoin('product.categories', 'category')
      .where('category.id IN (:...categoryIds)', { categoryIds: unique });

    if (options.withCategories) {
      qb.leftJoinAndSelect('product.categories', 'selectedCategory');
    }

    return qb.getMany();
  }

  private async countOverridesForProducts(productIds: number[]) {
    const unique = [...new Set(productIds)].filter(Boolean);

    if (!unique.length) return new Map<number, number>();

    const rows = await this.overrideRepo
      .createQueryBuilder('override')
      .select('override.product_id', 'productId')
      .addSelect('COUNT(override.id)', 'count')
      .where('override.product_id IN (:...productIds)', { productIds: unique })
      .groupBy('override.product_id')
      .getRawMany<{ productId: number; count: string }>();

    return new Map(rows.map(row => [Number(row.productId), Number(row.count)]));
  }

  // ============================================================
  // کمکی‌ها
  // ============================================================

  private validateFiles(files: Express.Multer.File[] = []) {
    return (files ?? [])
      .map(file => fileSizeValidationPipe.transform(file))
      .filter((file): file is Express.Multer.File => Boolean(file));
  }

  private async attachMeasurementImages(
    guideId: number,
    files: Express.Multer.File[],
    startOrder: number,
  ) {
    for (const [index, file] of files.entries()) {
      const { filename } = this.filesService.saveFile(file);

      await this.measurementImageRepo.save(
        this.measurementImageRepo.create({
          measurementGuideId: guideId,
          file: filename,
          caption: null,
          order: startOrder + index,
        }),
      );
    }
  }

  private entityTargetByType(type: GuideType): EntityTarget<ObjectLiteral> {
    if (type === GuideType.SIZE_TABLE) return SizeTable;
    if (type === GuideType.CARE_GUIDE) return CareGuide;

    return MeasurementGuide;
  }

  private modeOfSetting(type: GuideType, setting: object): GuideMode {
    const mode = (setting as Record<string, unknown>)[MODE_COLUMNS[type]] as
      GuideMode | undefined;

    return mode ?? GuideMode.INHERIT;
  }

  private guideIdOfSetting(type: GuideType, setting: object): number | null {
    return (
      ((setting as Record<string, unknown>)[GUIDE_COLUMNS[type]] as
        number | null) ?? null
    );
  }

  /** برای محصول: مقدار `null` یعنی بازگشت به راهنمای دسته */
  private applyProductSettingField(
    setting: ProductGuideSetting,
    type: GuideType,
    value: number | null | undefined,
  ) {
    if (value === undefined) return;

    const modeColumn = MODE_COLUMNS[type] as
      'sizeTableMode' | 'careGuideMode' | 'measurementGuideMode';

    const guideColumn = GUIDE_COLUMNS[type] as
      'sizeTableId' | 'careGuideId' | 'measurementGuideId';

    setting[modeColumn] = value ? GuideMode.CUSTOM : GuideMode.INHERIT;
    setting[guideColumn] = value ?? null;
  }

  private settingToPlain(setting?: CategoryGuideSetting) {
    if (!setting) return null;

    return {
      id: setting.id,
      categoryId: setting.categoryId,
      sizeTableId: setting.sizeTableId,
      careGuideId: setting.careGuideId,
      measurementGuideId: setting.measurementGuideId,
    };
  }

  private mergeValue(
    next: number | null | undefined,
    current: number | null,
  ): number | null {
    return next === undefined ? current : next;
  }

  private parseIdList(value?: string | null): number[] {
    if (!value) return [];

    return String(value)
      .replace(/[[\]\s]/g, '')
      .split(',')
      .map(item => Number(item))
      .filter(item => Number.isFinite(item) && item > 0);
  }

  private toSizeTableDefinition(table: SizeTable) {
    const columns = this.sortColumns(table.columns);

    return {
      id: table.id,
      name: table.name,
      unit: table.unit,
      notes: table.notes,
      isArchived: table.isArchived,
      columns: columns.map(column => ({
        id: column.id,
        label: column.label,
      })),
      rows: this.sortRows(table.rows).map(row => ({
        id: row.id,
        label: row.label,
        cells: columns.map(column => ({
          columnId: column.id,
          value:
            row.cells?.find(cell => cell.columnId === column.id)?.value ?? null,
        })),
      })),
    };
  }

  private toCareGuideDefinition(guide: CareGuide) {
    return {
      id: guide.id,
      name: guide.name,
      notes: guide.notes,
      isArchived: guide.isArchived,
      instructions: this.sortInstructions(guide.instructions).map(
        instruction => ({
          id: instruction.id,
          text: instruction.text,
          iconKey: instruction.iconKey,
        }),
      ),
    };
  }

  private toMeasurementGuideDefinition(guide: MeasurementGuide) {
    return {
      id: guide.id,
      name: guide.name,
      notes: guide.notes,
      isArchived: guide.isArchived,
      images: this.sortImages(guide.images).map(image => ({
        id: image.id,
        file: image.file,
        caption: image.caption,
        order: image.order,
      })),
    };
  }

  private sizeTableListItem(
    table: SizeTable,
    counts: Map<number, { columns: number; rows: number }> = new Map(),
  ) {
    const count = counts.get(table.id);

    return {
      id: table.id,
      name: table.name,
      unit: table.unit,
      notes: table.notes,
      isArchived: table.isArchived,
      columnCount: count?.columns ?? 0,
      rowCount: count?.rows ?? 0,
      updatedAt: table.updatedAt,
    };
  }

  private careGuideListItem(
    guide: CareGuide,
    counts: Map<number, number> = new Map(),
  ) {
    return {
      id: guide.id,
      name: guide.name,
      notes: guide.notes,
      isArchived: guide.isArchived,
      instructionCount: counts.get(guide.id) ?? 0,
      updatedAt: guide.updatedAt,
    };
  }

  private measurementGuideListItem(
    guide: MeasurementGuide,
    counts: Map<number, number> = new Map(),
  ) {
    return {
      id: guide.id,
      name: guide.name,
      notes: guide.notes,
      isArchived: guide.isArchived,
      imageCount: counts.get(guide.id) ?? 0,
      updatedAt: guide.updatedAt,
    };
  }

  /** تعداد ستون و ردیف هر جدول (برای لیست پنل) */
  private async countSizeTableChildren(ids: number[]) {
    const unique = [...new Set(ids)].filter(Boolean);

    const result = new Map<number, { columns: number; rows: number }>();

    if (!unique.length) return result;

    const [columns, rows] = await Promise.all([
      this.columnRepo
        .createQueryBuilder('column')
        .select('column.size_table_id', 'id')
        .addSelect('COUNT(column.id)', 'count')
        .where('column.size_table_id IN (:...ids)', { ids: unique })
        .groupBy('column.size_table_id')
        .getRawMany<{ id: number; count: string }>(),
      this.rowRepo
        .createQueryBuilder('row')
        .select('row.size_table_id', 'id')
        .addSelect('COUNT(row.id)', 'count')
        .where('row.size_table_id IN (:...ids)', { ids: unique })
        .groupBy('row.size_table_id')
        .getRawMany<{ id: number; count: string }>(),
    ]);

    for (const id of unique) {
      result.set(id, {
        columns: Number(
          columns.find(item => Number(item.id) === id)?.count ?? 0,
        ),
        rows: Number(rows.find(item => Number(item.id) === id)?.count ?? 0),
      });
    }

    return result;
  }

  private async countCareInstructions(ids: number[]) {
    const unique = [...new Set(ids)].filter(Boolean);

    if (!unique.length) return new Map<number, number>();

    const rows = await this.instructionRepo
      .createQueryBuilder('instruction')
      .select('instruction.care_guide_id', 'id')
      .addSelect('COUNT(instruction.id)', 'count')
      .where('instruction.care_guide_id IN (:...ids)', { ids: unique })
      .groupBy('instruction.care_guide_id')
      .getRawMany<{ id: number; count: string }>();

    return new Map(rows.map(row => [Number(row.id), Number(row.count)]));
  }

  private async countMeasurementImages(ids: number[]) {
    const unique = [...new Set(ids)].filter(Boolean);

    if (!unique.length) return new Map<number, number>();

    const rows = await this.measurementImageRepo
      .createQueryBuilder('image')
      .select('image.measurement_guide_id', 'id')
      .addSelect('COUNT(image.id)', 'count')
      .where('image.measurement_guide_id IN (:...ids)', { ids: unique })
      .groupBy('image.measurement_guide_id')
      .getRawMany<{ id: number; count: string }>();

    return new Map(rows.map(row => [Number(row.id), Number(row.count)]));
  }

  private sortColumns(columns?: SizeTableColumn[]) {
    return [...(columns ?? [])].sort(
      (first, second) => first.order - second.order || first.id - second.id,
    );
  }

  private sortRows(rows?: SizeTableRow[]) {
    return [...(rows ?? [])].sort(
      (first, second) => first.order - second.order || first.id - second.id,
    );
  }

  private sortInstructions(instructions?: CareInstruction[]) {
    return [...(instructions ?? [])].sort(
      (first, second) => first.order - second.order || first.id - second.id,
    );
  }

  private sortImages(images?: MeasurementImage[]) {
    return [...(images ?? [])].sort(
      (first, second) => first.order - second.order || first.id - second.id,
    );
  }
}
