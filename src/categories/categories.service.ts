import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  applySearch,
  applySort,
  getPagination,
  QueryDto,
} from 'src/common/query';
import { FilesService } from 'src/files/files.service';
import { In, Repository } from 'typeorm';

import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Category } from './entities/category.entity';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    private readonly filesService: FilesService,
  ) {}

  async create(
    createCategoryDto: CreateCategoryDto,
    file?: Express.Multer.File,
  ) {
    let image: string = '';

    if (file) {
      const result = this.filesService.saveFile(file);
      image = result.filename;
    }

    const category = this.categoriesRepository.create({
      ...createCategoryDto,
      image,
    });

    return await this.categoriesRepository.save(category);
  }

  async findAll(query: QueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const qb = this.categoriesRepository.createQueryBuilder('category');

    // search
    applySearch(qb, query.search, ['category.name', 'category.slug']);

    // sort
    applySort(qb, query.sort);

    if (query['isInHeroSection'] !== undefined) {
      const isHero =
        query['isInHeroSection'] === 'true' ||
        query['isInHeroSection'] === true;
      qb.andWhere('category.isInHeroSection = :isHero', { isHero });
    }

    if (query['isInHome'] !== undefined) {
      const isHome = query['isInHome'] === 'true' || query['isInHome'] === true;
      qb.andWhere('category.isInHome = :isHome', { isHome });
    }

    const isAll = query['all'] === 'true' || query['all'] === true;

    let data, total;
    if (isAll) {
      // بدون پیجینیشن - همه رکوردها
      data = await qb.getMany();
      total = data.length;
    } else {
      // با پیجینیشن
      const { skip, take } = getPagination(page, limit);
      qb.skip(skip).take(take);
      const [result, count] = await qb.getManyAndCount();
      data = result;
      total = count;
    }

    return {
      data,
      pagination: {
        page: page,
        limit: limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: number) {
    const payload = await this.categoriesRepository.findOne({
      where: { id },
    });
    return payload;
  }

  async findOneBySlug(slug: string) {
    return this.categoriesRepository.findOne({ where: { slug } });
  }

  async findManyByIds(ids: number[]): Promise<Category[]> {
    if (!ids.length) return [];
    return this.categoriesRepository.findBy({ id: In(ids) });
  }

  async update(
    id: number,
    updateCategoryDto: UpdateCategoryDto,
    file?: Express.Multer.File,
  ) {
    const categoryEntity = await this.categoriesRepository.findOne({
      where: { id },
    });

    if (!categoryEntity) throw new NotFoundException();

    if (file) {
      const result = this.filesService.saveFile(file);
      categoryEntity.image = result.filename;
    }
    Object.assign(categoryEntity, updateCategoryDto);

    return this.categoriesRepository.save(categoryEntity);
  }

  async remove(id: number) {
    const user = await this.categoriesRepository.findOne({
      where: { id },
    });

    if (!user) throw new NotFoundException();

    return this.categoriesRepository.delete(id);
  }
}
