import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CategoriesService } from 'src/categories/categories.service';
import {
  applySearch,
  applySort,
  getPagination,
  QueryDto,
} from 'src/common/query';
import { FilesService } from 'src/files/files.service';
import { DataSource, In, QueryRunner, Repository } from 'typeorm';

import {
  AddColorDto,
  AddSizeDto,
  CreateProductDto,
} from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product } from './entities/product.entity';
import { Color } from './entities/product-color.entity';
import { ProductColorImage } from './entities/product-color-image.entity';
import { Size } from './entities/product-size.entity';
import { Variant } from './entities/variant.entity';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productRepo: Repository<Product>,
    @InjectRepository(Variant)
    private variantRepo: Repository<Variant>,
    @InjectRepository(Color)
    private colorRepo: Repository<Color>,
    @InjectRepository(Size)
    private sizeRepo: Repository<Size>,
    @InjectRepository(ProductColorImage)
    private colorImageRepo: Repository<ProductColorImage>,

    private dataSource: DataSource,
    private readonly categoriesService: CategoriesService,
    private readonly filesService: FilesService,
  ) {}

  async create(
    createProductDto: CreateProductDto,
    file: Express.Multer.File,
  ): Promise<Product> {
    const {
      productCode,
      title,
      slug,
      description,
      careInstructionsHtml,
      categoryIds,
      variants,
    } = createProductDto;

    let image: string = '';

    console.log(file, file?.originalname);
    if (file) {
      const result = this.filesService.saveFile(file);
      image = result.filename;
    }

    // ۱. ایجاد محصول اصلی
    const product = this.productRepo.create({
      productCode,
      title,
      slug,
      description,
      careInstructionsHtml,
      image,
    });
    await this.productRepo.save(product);

    if (categoryIds && categoryIds.length) {
      const categories =
        await this.categoriesService.findManyByIds(categoryIds);
      if (categories.length !== categoryIds.length) {
        throw new BadRequestException('یکی از دسته‌بندی‌ها وجود ندارد');
      }
      product.categories = categories;
      await this.productRepo.save(product);
    }

    // ۲. واکشی رنگ‌ها و سایزها برای اعتبارسنجی
    const colorIds = variants.map(v => v.colorId);
    const sizeIds = variants.map(v => v.sizeId);

    const existingColors = await this.colorRepo.findBy({ id: In(colorIds) });
    const existingSizes = await this.sizeRepo.findBy({ id: In(sizeIds) });

    if (existingColors.length !== new Set(colorIds).size) {
      throw new BadRequestException('One or more color IDs are invalid.');
    }
    if (existingSizes.length !== new Set(sizeIds).size) {
      throw new BadRequestException('One or more size IDs are invalid.');
    }

    // ۳. ایجاد واریانت‌ها
    const variantEntities = variants.map(v => {
      const color = existingColors.find(c => c.id === v.colorId);
      const size = existingSizes.find(s => s.id === v.sizeId);
      return this.variantRepo.create({
        product,
        color,
        size,
        price: v.price,
        stock: v.stock ?? 0,
      });
    });

    await this.variantRepo.save(variantEntities);

    return this.productRepo.findOneOrFail({
      where: { id: product.id },
      relations: {
        variants: {
          color: true,
          size: true,
        },
        categories: true,
      },
    });
  }

  async addColor(addColorDto: AddColorDto) {
    const color = this.colorRepo.create(addColorDto);

    return this.colorRepo.save(color);
  }

  async addSize(addSizeDto: AddSizeDto) {
    const size = this.sizeRepo.create(addSizeDto);

    return this.sizeRepo.save(size);
  }

  async addColorImages(
    productId: number,
    files: Express.Multer.File[],
    colorIds: number[],
  ): Promise<ProductColorImage[]> {
    const product = await this.productRepo.findOneBy({ id: productId });
    if (!product) throw new NotFoundException('محصول یافت نشد');

    const uniqueColorIds = [...new Set(colorIds)];
    const colors = await this.colorRepo.findBy({ id: In(uniqueColorIds) });
    if (colors.length !== uniqueColorIds.length) {
      throw new BadRequestException('یکی از رنگ‌ها معتبر نیست');
    }

    const images: ProductColorImage[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const colorId = colorIds[i] || null; // اگر colorId ارسال نشده باشد

      if (!colorId) {
        throw new BadRequestException(
          `برای فایل شماره ${i + 1} رنگ مشخص نشده است`,
        );
      }

      const color = colors.find(c => c.id === colorId);
      if (!color) {
        throw new BadRequestException(
          `رنگ با شناسه ${colorId} برای فایل شماره ${i + 1} معتبر نیست`,
        );
      }

      const savedFile = this.filesService.saveFile(file);

      const image = this.colorImageRepo.create({
        url: savedFile.filename,
        order: i,
        product,
        color,
      });
      images.push(image);
    }

    return this.colorImageRepo.save(images);
  }

  async deleteImage(id: number) {
    const image = await this.colorImageRepo.findOneBy({ id });
    if (!image) throw new NotFoundException('تصویر یافت نشد');

    // حذف فایل از سرور (اختیاری)
    this.filesService.deleteFile(image.url);

    return this.colorImageRepo.delete(id);
  }

  async findAll(query: QueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const qb = this.productRepo.createQueryBuilder('products');

    qb.leftJoinAndSelect('products.variants', 'variant')
      .leftJoinAndSelect('variant.color', 'color')
      .leftJoinAndSelect('variant.size', 'size')
      .leftJoinAndSelect('products.categories', 'category')
      .leftJoinAndSelect('products.colorImages', 'colorImages')
      .leftJoinAndSelect('colorImages.color', 'imageColor')
      .leftJoinAndSelect('products.suggestedProducts', 'suggestedProducts');

    // search
    applySearch(qb, query.search, [
      'products.title',
      'products.slug',
      'products.productCode',
    ]);

    // sort
    applySort(qb, query.sort);

    // pagination
    const { skip, take } = getPagination(page, limit);
    qb.skip(skip).take(take);

    const [data, total] = await qb.getManyAndCount();

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

  async allColors() {
    return this.colorRepo.find();
  }

  async allSizes() {
    return this.sizeRepo.find();
  }

  async findOne(id: number) {
    const payload = await this.productRepo.findOne({
      where: { id },
    });
    return payload;
  }

  async update(
    id: number,
    updateProductDto: UpdateProductDto,
    file?: Express.Multer.File,
  ): Promise<Product> {
    // 1. پیدا کردن محصول موجود با روابط لازم
    const product = await this.productRepo.findOne({
      where: { id },
      relations: {
        variants: true,
        categories: true,
      },
    });
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }

    // 2. بررسی یکتایی productCode در صورت تغییر
    if (
      updateProductDto.productCode &&
      updateProductDto.productCode !== product.productCode
    ) {
      const existing = await this.productRepo.findOneBy({
        productCode: updateProductDto.productCode,
      });
      if (existing) {
        throw new ConflictException('Product code already exists');
      }
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 3. به‌روزرسانی فیلدهای اصلی محصول (به جز روابط)
      const { variants, categoryIds, ...simpleFields } = updateProductDto;

      // به‌روزرسانی تصویر در صورت ارسال فایل جدید
      if (file) {
        const savedFile = this.filesService.saveFile(file);
        // حذف فایل قبلی (اختیاری)
        if (product.image) {
          this.filesService.deleteFile(product.image);
        }
        product.image = savedFile.filename;
      }

      // اعمال سایر فیلدهای ساده
      Object.assign(product, simpleFields);
      await queryRunner.manager.save(product);

      // 4. به‌روزرسانی واریانت‌ها (حذف و ایجاد مجدد)
      if (variants) {
        // حذف واریانت‌های قبلی
        await queryRunner.manager.delete(Variant, {
          product: { id: product.id },
        });

        // اعتبارسنجی رنگ‌ها و سایزها
        const colorIds = variants.map(v => v.colorId);
        const sizeIds = variants.map(v => v.sizeId);

        const existingColors = await this.colorRepo.findBy({
          id: In(colorIds),
        });
        const existingSizes = await this.sizeRepo.findBy({ id: In(sizeIds) });

        if (existingColors.length !== new Set(colorIds).size) {
          throw new BadRequestException('One or more color IDs are invalid.');
        }
        if (existingSizes.length !== new Set(sizeIds).size) {
          throw new BadRequestException('One or more size IDs are invalid.');
        }

        // ایجاد واریانت‌های جدید
        const newVariants = variants.map(v => {
          const color = existingColors.find(c => c.id === v.colorId);
          const size = existingSizes.find(s => s.id === v.sizeId);
          return queryRunner.manager.create(Variant, {
            product,
            color,
            size,
            price: v.price,
            stock: v.stock ?? 0,
          });
        });
        await queryRunner.manager.save(newVariants);
      }

      // 5. به‌روزرسانی دسته‌بندی‌ها
      if (categoryIds !== undefined) {
        if (categoryIds.length === 0) {
          product.categories = [];
        } else {
          const categories =
            await this.categoriesService.findManyByIds(categoryIds);
          if (categories.length !== categoryIds.length) {
            throw new BadRequestException('One or more category IDs invalid');
          }
          product.categories = categories;
        }
        await queryRunner.manager.save(product);
      }

      // 6. دریافت محصول نهایی با روابط مورد نیاز
      const updatedProduct = await queryRunner.manager.findOneOrFail(Product, {
        where: { id: product.id },
        relations: {
          variants: { color: true, size: true },
          categories: true,
          // colorImages و suggestedProducts عمداً حذف شده‌اند
        },
      });

      await queryRunner.commitTransaction();
      return updatedProduct;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // متد کمکی برای به‌روزرسانی واریانت‌ها
  private async updateVariants(
    productId: number,
    newVariantsDto: {
      color: string;
      size: string;
      price: number;
      stock?: number;
    }[],
    queryRunner: any,
  ) {
    // دریافت واریانت‌های موجود
    const existingVariants = await queryRunner.manager.find(Variant, {
      where: { product: { id: productId } },
    });

    // نگاشت برای جستجوی سریع (شناسایی با ترکیب color+size)
    const existingMap = new Map<string, Variant>();
    for (const variant of existingVariants) {
      existingMap.set(`${variant.color}|${variant.size}`, variant);
    }

    const toRemove: Variant[] = [];
    const toSave: Variant[] = [];

    for (const dto of newVariantsDto) {
      const key = `${dto.color}|${dto.size}`;
      const existing = existingMap.get(key);
      if (existing) {
        // به‌روزرسانی واریانت موجود (فقط قیمت و موجودی)
        existing.price = dto.price;
        existing.stock = dto.stock ?? 0;
        toSave.push(existing);
        existingMap.delete(key);
      } else {
        // ایجاد واریانت جدید
        const newVariant = queryRunner.manager.create(Variant, {
          ...dto,
          product: { id: productId },
        });
        toSave.push(newVariant);
      }
    }

    // واریانت‌هایی که باقی مانده‌اند باید حذف شوند
    for (const remaining of existingMap.values()) {
      toRemove.push(remaining);
    }

    if (toRemove.length) await queryRunner.manager.remove(toRemove);
    if (toSave.length) await queryRunner.manager.save(toSave);
  }

  private async updateProductCategories(
    product: Product,
    categoryIds: number[],
    queryRunner: QueryRunner,
  ) {
    if (!categoryIds.length) {
      product.categories = [];
    } else {
      // استفاده از سرویس CategoriesService (بدون queryRunner)
      // توجه: این سرویس از ریپازیتوری معمولی استفاده می‌کند، نه queryRunner فعلی.
      // اما چون فقط read است، در تراکنش اختلالی ایجاد نمی‌کند.
      const categories =
        await this.categoriesService.findManyByIds(categoryIds);
      if (categories.length !== categoryIds.length) {
        throw new NotFoundException('One or more category IDs invalid');
      }
      product.categories = categories;
    }
    await queryRunner.manager.save(product);
  }

  // products.service.ts
  async updateSuggestedProducts(
    productId: number,
    suggestedProductIds: number[],
  ): Promise<Product> {
    // ۱. پیدا کردن محصول اصلی
    const product = await this.productRepo.findOne({
      where: { id: productId },
      relations: {
        suggestedProducts: true,
      },
    });
    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found`);
    }

    // ۲. پیدا کردن محصولات پیشنهادی با شناسه‌های ارسالی
    let suggestedProducts: Product[] = [];
    if (suggestedProductIds.length > 0) {
      suggestedProducts = await this.productRepo.findBy({
        id: In(suggestedProductIds),
      });
      if (suggestedProducts.length !== suggestedProductIds.length) {
        throw new BadRequestException(
          'One or more suggested product IDs are invalid',
        );
      }
    }

    // ۳. به‌روزرسانی رابطه many-to-many
    product.suggestedProducts = suggestedProducts;
    await this.productRepo.save(product);

    // ۴. بازگرداندن محصول به‌روز شده با روابط
    return this.productRepo.findOneOrFail({
      where: { id: productId },
      relations: {
        suggestedProducts: true,
      },
    });
  }

  async remove(id: number) {
    const product = await this.productRepo.findOne({
      where: { id },
      relations: {
        colorImages: true,
      },
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }

    if (product.image) {
      this.filesService.deleteFile(product.image);
    }

    if (product.colorImages && product.colorImages.length > 0) {
      for (const image of product.colorImages) {
        if (image.url) {
          this.filesService.deleteFile(image.url);
        }
      }
    }

    await this.productRepo.delete(id);

    return { message: 'Product deleted successfully' };
  }
}
