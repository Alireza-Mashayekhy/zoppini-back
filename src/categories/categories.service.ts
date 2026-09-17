import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  applySearch,
  applySort,
  getPagination,
  QueryDto,
} from 'src/common/query';
import { FilesService } from 'src/files/files.service';
import { DataSource, In, Repository } from 'typeorm';

import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Category } from './entities/category.entity';
import { CategoryImages } from './utils/category-images.util';
import { collectCategoryIdsWithDescendants } from './utils/category-tree.util';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    private readonly filesService: FilesService,
    private dataSource: DataSource,
  ) {}

  private normalizeSecondImages<T extends Category>(
    category: T | null,
  ): T | null {
    if (category && !Array.isArray(category.secondImages)) {
      category.secondImages = [];
    }

    return category;
  }

  private deleteSecondImageFiles(filenames?: string[] | null): void {
    for (const filename of filenames ?? []) {
      if (filename) {
        this.filesService.deleteFile(filename);
      }
    }
  }

  private async shiftOrders(
    field: 'orderInHome' | 'orderInHero', // کدام فیلد
    newOrder: number,
    excludeId?: number, // در هنگام آپدیت، خود رکورد را استثنا کنیم
  ): Promise<void> {
    if (newOrder < 1) return; // orderهای کمتر از 1 نادیده گرفته شوند

    const qb = this.categoriesRepository
      .createQueryBuilder()
      .update(Category)
      .set({
        [field]: () => `${field} + 1`, // افزایش order به‌میزان 1
      })
      .where(`${field} >= :newOrder`, { newOrder });

    if (excludeId) {
      qb.andWhere('id != :excludeId', { excludeId });
    }

    await qb.execute();
  }

  async create(
    createCategoryDto: CreateCategoryDto,
    images: CategoryImages = {},
  ) {
    const { orderInHome, orderInHero, ...rest } = createCategoryDto;

    // شروع تراکنش
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // اگر order درخواستی داده شده، ابتدا orderهای موجود را shift کن
      if (orderInHome && orderInHome > 0) {
        await this.shiftOrders('orderInHome', orderInHome);
      }
      if (orderInHero && orderInHero > 0) {
        await this.shiftOrders('orderInHero', orderInHero);
      }

      let image = '';
      if (images.primary) {
        image = this.filesService.saveFile(images.primary).filename;
      }

      const secondImages = (images.second ?? []).map(
        file => this.filesService.saveFile(file).filename,
      );

      const category = queryRunner.manager.create(Category, {
        ...rest,
        image,
        secondImages,
        orderInHome: orderInHome || 0,
        orderInHero: orderInHero || 0,
      });

      const saved = await queryRunner.manager.save(category);
      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async findAll(query: QueryDto & { includeInactive?: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.categoriesRepository.createQueryBuilder('category');

    // فقط در API عمومی دسته‌بندی‌های فعال
    const includeInactive = query.includeInactive === 'true';

    if (!includeInactive) {
      qb.andWhere('category.isActive = :isActive', {
        isActive: true,
      });
    }

    applySearch(qb, query.search, ['category.name', 'category.slug']);

    if (query['isInHeroSection'] !== undefined) {
      const isHero =
        query['isInHeroSection'] === 'true' ||
        query['isInHeroSection'] === true;

      qb.andWhere('category.isInHeroSection = :isHero', {
        isHero,
      });
    }

    if (query['isInHome'] !== undefined) {
      const isHome = query['isInHome'] === 'true' || query['isInHome'] === true;

      qb.andWhere('category.isInHome = :isHome', {
        isHome,
      });
    }

    if (query.sort) {
      applySort(qb, query.sort);
    } else {
      if (query['isInHome'] !== undefined) {
        qb.orderBy('category.orderInHome', 'ASC');
      }

      if (query['isInHeroSection'] !== undefined) {
        qb.addOrderBy('category.orderInHero', 'ASC');
      }
    }

    const isAll = query['all'] === 'true' || query['all'] === true;

    let data;
    let total;

    if (isAll) {
      data = await qb.getMany();
      total = data.length;
    } else {
      const { skip, take } = getPagination(page, limit);

      qb.skip(skip).take(take);

      const [result, count] = await qb.getManyAndCount();

      data = result;
      total = count;
    }

    return {
      data: (data as Category[]).map(category =>
        this.normalizeSecondImages(category),
      ),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: number) {
    const payload = await this.categoriesRepository.findOne({
      where: { id },
    });
    return this.normalizeSecondImages(payload);
  }

  async findOneBySlug(slug: string) {
    const payload = await this.categoriesRepository.findOne({
      where: { slug },
    });

    return this.normalizeSecondImages(payload);
  }

  async findManyByIds(ids: number[]): Promise<Category[]> {
    if (!ids.length) return [];
    const categories = await this.categoriesRepository.findBy({ id: In(ids) });

    return categories.map(
      category => this.normalizeSecondImages(category) as Category,
    );
  }

  async findWithDescendantIds(ids: number[]): Promise<number[]> {
    if (!ids?.length) return [];

    const categories = await this.categoriesRepository.find({
      select: { id: true, parentId: true },
    });

    return collectCategoryIdsWithDescendants(ids, categories);
  }

  async update(
    id: number,
    updateCategoryDto: UpdateCategoryDto,
    images: CategoryImages = {},
  ) {
    const category = await this.categoriesRepository.findOne({ where: { id } });
    if (!category) throw new NotFoundException();

    const { orderInHome, orderInHero, removeSecondImages, ...rest } =
      updateCategoryDto;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // مدیریت orderInHome
      if (orderInHome !== undefined && orderInHome !== category.orderInHome) {
        const newOrder = orderInHome ?? 0; // تبدیل null به 0
        if (newOrder > 0) {
          await this.shiftOrders('orderInHome', newOrder, id);
        }
        category.orderInHome = newOrder;
      }

      // مدیریت orderInHero
      if (orderInHero !== undefined && orderInHero !== category.orderInHero) {
        const newOrder = orderInHero ?? 0;
        if (newOrder > 0) {
          await this.shiftOrders('orderInHero', newOrder, id);
        }
        category.orderInHero = newOrder;
      }

      // به‌روزرسانی تصویر (اگر وجود داشته باشد)
      if (images.primary) {
        const result = this.filesService.saveFile(images.primary);
        if (category.image) {
          this.filesService.deleteFile(category.image);
        }
        category.image = result.filename;
      }

      if (images.second?.length) {
        const newFilenames = images.second.map(
          file => this.filesService.saveFile(file).filename,
        );

        this.deleteSecondImageFiles(category.secondImages);
        category.secondImages = newFilenames;
      } else if (removeSecondImages && category.secondImages?.length) {
        // فایل جدیدی نیامده و ادمین خواسته تصویرهای دوم پاک شوند
        this.deleteSecondImageFiles(category.secondImages);
        category.secondImages = [];
      }

      // به‌روزرسانی سایر فیلدها
      Object.assign(category, rest);

      const updated = await queryRunner.manager.save(category);
      await queryRunner.commitTransaction();
      return updated;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async remove(id: number) {
    const user = await this.categoriesRepository.findOne({
      where: { id },
    });

    if (!user) throw new NotFoundException();

    return this.categoriesRepository.delete(id);
  }
}
