import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CategoriesService } from 'src/categories/categories.service';
import { applySearch, getPagination, QueryDto } from 'src/common/query';
import { FilesService } from 'src/files/files.service';
import { RahkaranService } from 'src/rahkaran/rahkaran.service';
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
  private readonly logger = new Logger(ProductsService.name);

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
    @Inject(forwardRef(() => RahkaranService))
    private readonly rahkaranService: RahkaranService,
  ) {}

  async create(
    createProductDto: CreateProductDto,
    file?: Express.Multer.File,
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
    if (file) {
      const result = this.filesService.saveFile(file);
      image = result.filename;
    }

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

    if (variants && variants.length) {
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

      // ساخت واریانت‌ها با مقداردهی همزمان ستون‌ها و روابط
      const variantEntities = variants.map(v => {
        const color = existingColors.find(c => c.id === v.colorId);
        const size = existingSizes.find(s => s.id === v.sizeId);
        if (!color || !size) {
          throw new BadRequestException(
            `رنگ یا سایز معتبر برای واریانت یافت نشد: colorId=${v.colorId}, sizeId=${v.sizeId}`,
          );
        }

        return {
          productId: product.id,
          colorId: v.colorId,
          sizeId: v.sizeId,
          product,
          color,
          size,
          price: v.price,
          stock: v.stock ?? 0,
          sku: v.sku || undefined,
        };
      });

      await this.variantRepo.save(variantEntities);
    }

    return this.productRepo.findOneOrFail({
      where: { id: product.id },
      relations: {
        variants: { color: true, size: true },
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

  async findAll(
    query: QueryDto,
    filters?: {
      categoryIds?: number[];
      colorIds?: number[];
      sizeIds?: number[];
    },
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const qb = this.productRepo.createQueryBuilder('products');

    qb.leftJoinAndSelect('products.variants', 'variant')
      .leftJoinAndSelect('variant.color', 'color')
      .leftJoinAndSelect('variant.size', 'size')
      .leftJoinAndSelect('products.categories', 'category')
      .leftJoinAndSelect('products.colorImages', 'colorImages')
      .leftJoinAndSelect('colorImages.color', 'imageColor')
      .leftJoinAndSelect('products.sameColorProducts', 'sameColorProducts')
      .leftJoinAndSelect('products.suggestedProducts', 'suggestedProducts');

    if (filters?.categoryIds?.length) {
      qb.andWhere('category.id IN (:...categoryIds)', {
        categoryIds: filters.categoryIds,
      });
    }

    if (filters?.colorIds?.length) {
      qb.andWhere('color.id IN (:...colorIds)', {
        colorIds: filters.colorIds,
      });
    }

    if (filters?.sizeIds?.length) {
      qb.andWhere('size.id IN (:...sizeIds)', {
        sizeIds: filters.sizeIds,
      });
    }

    // search
    applySearch(qb, query.search, [
      'products.title',
      'products.slug',
      'products.productCode',
    ]);

    // sort
    if (query.sort) {
      const [field, order] = query.sort.split(':');
      const direction = (order?.toUpperCase() as any) || 'ASC';
      switch (field) {
        case 'title':
          qb.orderBy('products.title', direction);
          break;
        case 'price':
          qb.orderBy('variant.price', direction);
          break;
        case 'createdAt':
          qb.orderBy('products.createdAt', direction);
          break;
        default:
          qb.orderBy('products.id', direction);
      }
    }

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

  async findByCode(code: string): Promise<Product | null> {
    return this.productRepo.findOne({ where: { productCode: code } });
  }

  async findById(id: number): Promise<Product> {
    const product = await this.productRepo.findOne({ where: { id } });
    if (!product) {
      throw new NotFoundException(`محصول با شناسه ${id} یافت نشد`);
    }
    return product;
  }

  async getVariantsByProductId(productId: number): Promise<Variant[]> {
    return this.variantRepo.find({
      where: { productId },
      relations: {
        color: true,
        size: true,
      },
    });
  }

  async addVariant(data: {
    productId: number;
    colorId: number;
    sizeId: number;
    price: number;
    stock: number;
    sku?: string;
  }): Promise<Variant> {
    const product = await this.findById(data.productId);
    const color = await this.colorRepo.findOne({ where: { id: data.colorId } });
    if (!color) throw new NotFoundException('رنگ یافت نشد');
    const size = await this.sizeRepo.findOne({ where: { id: data.sizeId } });
    if (!size) throw new NotFoundException('سایز یافت نشد');

    const variant = this.variantRepo.create({
      product,
      color,
      size,
      price: data.price,
      stock: data.stock,
      sku: data.sku,
    });
    return this.variantRepo.save(variant);
  }

  // به‌روزرسانی واریانت
  async updateVariant(
    variantId: number,
    data: { price?: number; stock?: number; sku?: string },
  ): Promise<Variant> {
    const variant = await this.variantRepo.findOne({
      where: { id: variantId },
    });
    if (!variant) {
      throw new NotFoundException(`واریانت با شناسه ${variantId} یافت نشد`);
    }
    Object.assign(variant, data);
    return this.variantRepo.save(variant);
  }

  async allColors() {
    return this.colorRepo.find();
  }

  async allSizes() {
    return this.sizeRepo.find();
  }

  async findOne(slug: string) {
    let product = await this.productRepo.findOne({
      where: { slug },
      relations: {
        variants: {
          color: true,
          size: true,
        },
        categories: true,
        colorImages: {
          color: true,
        },
        suggestedProducts: true,
        sameColorProducts: {
          colorImages: {
            color: true,
          },
        },
      },
    });

    if (!product) {
      const encodedSlug = encodeURIComponent(slug);
      product = await this.productRepo.findOne({
        where: { slug: encodedSlug },
        relations: {
          variants: {
            color: true,
            size: true,
          },
          categories: true,
          colorImages: {
            color: true,
          },
          suggestedProducts: true,
          sameColorProducts: {
            colorImages: {
              color: true,
            },
          },
        },
      });
    }

    if (!product) {
      throw new NotFoundException(`محصول با اسلاگ "${slug}" یافت نشد`);
    }

    try {
      await this.rahkaranService.updateProductStockAndPrice(product.id);
      this.logger.log(`✅ محصول ${product.id} با راهکاران همگام‌سازی شد.`);
    } catch (error) {
      this.logger.error(
        `❌ خطا در همگام‌سازی محصول ${product.id}`,
        error.message,
      );
    }

    // دریافت محصولات مرتبط (هم‌دسته)
    let relatedProducts: Product[] = [];
    if (product.categories && product.categories.length > 0) {
      const categoryIds = product.categories.map(cat => cat.id);
      relatedProducts = await this.productRepo
        .createQueryBuilder('p')
        .leftJoin('p.categories', 'cat')
        .where('cat.id IN (:...categoryIds)', { categoryIds })
        .andWhere('p.id != :productId', { productId: product.id })
        .orderBy('p.createdAt', 'DESC')
        .limit(10)
        .getMany();
    }

    return {
      product,
      relatedProducts,
    };
  }

  // ==================== متد update ====================
  async update(
    id: number,
    updateProductDto: UpdateProductDto,
    file?: Express.Multer.File,
  ): Promise<Product> {
    const product = await this.productRepo.findOne({
      where: { id },
      relations: { variants: true, categories: true },
    });
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }

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
      const { variants, categoryIds, ...simpleFields } = updateProductDto;

      if (file) {
        const savedFile = this.filesService.saveFile(file);
        if (product.image) this.filesService.deleteFile(product.image);
        product.image = savedFile.filename;
      }

      Object.assign(product, simpleFields);
      await queryRunner.manager.save(product);

      // به‌روزرسانی واریانت‌ها (اگر وجود داشته باشند)
      if (variants !== undefined) {
        // حذف فیلد id از واریانت‌ها (در صورت وجود)
        const cleanVariants = variants.map(v => {
          const { id: _id, ...rest } = v as any;
          return rest;
        });
        await this.updateVariants(product.id, cleanVariants, queryRunner);
      }

      // به‌روزرسانی دسته‌بندی‌ها
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

      const updatedProduct = await queryRunner.manager.findOneOrFail(Product, {
        where: { id: product.id },
        relations: {
          variants: { color: true, size: true },
          categories: true,
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

  // ==================== متد کمکی updateVariants ====================
  private async updateVariants(
    productId: number,
    newVariantsDto: {
      colorId: number;
      sizeId: number;
      price: number;
      stock?: number;
      sku?: string | null;
    }[],
    queryRunner: QueryRunner,
  ) {
    // دریافت واریانت‌های موجود برای این محصول
    const existingVariants = await queryRunner.manager.find(Variant, {
      where: { productId },
    });

    // نگاشت برای جستجوی سریع بر اساس کلید ترکیبی (colorId|sizeId)
    const existingMap = new Map<string, Variant>();
    for (const variant of existingVariants) {
      const key = `${variant.colorId}|${variant.sizeId}`;
      existingMap.set(key, variant);
    }

    const toRemove: Variant[] = [];
    const toSave: Variant[] = [];

    for (const dto of newVariantsDto) {
      const key = `${dto.colorId}|${dto.sizeId}`;
      const existing = existingMap.get(key);

      if (existing) {
        // به‌روزرسانی واریانت موجود
        existing.price = dto.price;
        existing.stock = dto.stock ?? 0;
        // اگر sku در DTO ارسال شده باشد، مقدار جدید را می‌گیرد (می‌تواند null باشد)
        if (dto.sku !== undefined) {
          existing.sku = dto.sku;
        }
        toSave.push(existing);
        existingMap.delete(key);
      } else {
        // ایجاد واریانت جدید
        const newVariant = new Variant();
        newVariant.productId = productId;
        newVariant.colorId = dto.colorId;
        newVariant.sizeId = dto.sizeId;
        newVariant.price = dto.price;
        newVariant.stock = dto.stock ?? 0;
        newVariant.sku = dto.sku ?? null;
        toSave.push(newVariant);
      }
    }

    // واریانت‌هایی که در درخواست جدید نیستند، حذف می‌شوند
    for (const remaining of existingMap.values()) {
      toRemove.push(remaining);
    }

    if (toRemove.length) {
      await queryRunner.manager.remove(toRemove);
    }
    if (toSave.length) {
      await queryRunner.manager.save(toSave);
    }
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

  async updateSameColorProducts(
    productId: number,
    sameColorProductIds: number[],
  ): Promise<Product> {
    const product = await this.productRepo.findOne({
      where: { id: productId },
      relations: { sameColorProducts: true },
    });
    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found`);
    }

    let sameColorProducts: Product[] = [];
    if (sameColorProductIds.length > 0) {
      sameColorProducts = await this.productRepo.findBy({
        id: In(sameColorProductIds),
      });
      if (sameColorProducts.length !== sameColorProductIds.length) {
        throw new BadRequestException(
          'One or more same-color product IDs are invalid',
        );
      }
    }

    product.sameColorProducts = sameColorProducts;
    await this.productRepo.save(product);

    return this.productRepo.findOneOrFail({
      where: { id: productId },
      relations: { sameColorProducts: true },
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
