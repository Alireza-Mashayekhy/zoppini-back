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
import { DiscountService } from 'src/discounts/discounts.service';
import { Discount, DiscountType } from 'src/discounts/entities/discount.entity';
import { FilesService } from 'src/files/files.service';
import { RahkaranService } from 'src/rahkaran/rahkaran.service';
import { RahkaranProduct } from 'src/rahkaran/rahkaran-product-sync.service';
import { DataSource, In, QueryRunner, Repository } from 'typeorm';

import {
  AddColorDto,
  AddSizeDto,
  CreateProductDto,
} from './dto/create-product.dto';
import { UpdateColorDto } from './dto/update-color.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateSizeDto } from './dto/update-size.dto';
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
    @InjectRepository(Discount)
    private discountRepo: Repository<Discount>,

    @Inject(forwardRef(() => DiscountService))
    private readonly discountsService: DiscountService,

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

    // دریافت تصاویر موجود برای این محصول
    const existingImages = await this.colorImageRepo.find({
      where: { product: { id: productId } },
      relations: { color: true },
      order: { order: 'ASC' },
    });

    // نگاشت رنگ به حداکثر order موجود
    const maxOrderMap = new Map<number, number>();
    for (const img of existingImages) {
      const colorId = img.color.id;
      const currentMax = maxOrderMap.get(colorId) ?? -1;
      if (img.order > currentMax) {
        maxOrderMap.set(colorId, img.order);
      }
    }

    const images: ProductColorImage[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const colorId = colorIds[i];
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

      // محاسبه order جدید: max + 1
      const currentMax = maxOrderMap.get(colorId) ?? -1;
      const newOrder = currentMax + 1;
      maxOrderMap.set(colorId, newOrder);

      const savedFile = this.filesService.saveFile(file);
      const image = this.colorImageRepo.create({
        url: savedFile.filename,
        order: newOrder,
        product,
        color,
      });
      images.push(image);
    }

    return this.colorImageRepo.save(images);
  }

  // src/products/products.service.ts

  async updateColorImagesOrder(
    productId: number,
    orders: { id: number; order: number }[],
  ): Promise<ProductColorImage[]> {
    const product = await this.productRepo.findOneBy({ id: productId });

    if (!product) {
      throw new NotFoundException('محصول یافت نشد');
    }

    const imageIds = orders.map(o => o.id);

    const existingImages = await this.colorImageRepo.find({
      where: {
        id: In(imageIds),
      },
      relations: {
        product: true,
        color: true,
      },
    });

    if (existingImages.length !== imageIds.length) {
      throw new BadRequestException('یکی از تصاویر یافت نشد');
    }

    // مطمئن شو تمام عکس‌ها متعلق به همین محصول هستند
    const invalidImage = existingImages.find(
      image => image.product.id !== productId,
    );

    if (invalidImage) {
      throw new BadRequestException('یکی از تصاویر متعلق به این محصول نیست');
    }

    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      /*
       * مرحله اول:
       *
       * تمام order های فعلی را موقتاً به مقادیر منفی
       * و غیرتکراری منتقل می‌کنیم تا Unique Constraint
       * هیچ برخوردی نداشته باشد.
       */
      for (let index = 0; index < existingImages.length; index++) {
        const image = existingImages[index];

        await queryRunner.manager.update(
          ProductColorImage,
          { id: image.id },
          {
            order: -(index + 1),
          },
        );
      }

      /*
       * مرحله دوم:
       *
       * order نهایی را اعمال می‌کنیم.
       */
      for (const item of orders) {
        await queryRunner.manager.update(
          ProductColorImage,
          { id: item.id },
          {
            order: item.order,
          },
        );
      }

      await queryRunner.commitTransaction();

      return this.colorImageRepo.find({
        where: {
          product: {
            id: productId,
          },
        },
        order: {
          order: 'ASC',
        },
        relations: {
          color: true,
        },
      });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async deleteImage(id: number) {
    const image = await this.colorImageRepo.findOneBy({ id });

    if (!image) {
      throw new NotFoundException('تصویر یافت نشد');
    }

    const filename = image.url;

    // اول DB
    await this.colorImageRepo.delete(id);

    // بعد فایل
    this.filesService.deleteFile(filename);

    return {
      message: 'تصویر با موفقیت حذف شد',
    };
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

    await this.attachDiscounts(data);

    return {
      data,
      pagination: {
        page,
        limit,
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
    const relations = {
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
        variants: {
          color: true,
          size: true,
        },
      },
    };

    let product = await this.productRepo.findOne({
      where: { slug },
      relations,
    });

    if (!product) {
      const encodedSlug = encodeURIComponent(slug);

      product = await this.productRepo.findOne({
        where: { slug: encodedSlug },
        relations,
      });
    }

    if (!product) {
      throw new NotFoundException(`محصول با اسلاگ "${slug}" یافت نشد`);
    }

    // =====================================================
    // DISCOUNT
    // =====================================================

    const categoryIds = product.categories?.map(category => category.id) ?? [];

    for (const variant of product.variants ?? []) {
      const originalPrice = Number(variant.price);

      const discountResult =
        await this.discountsService.getBestDiscountForProduct(
          product.id,
          categoryIds,
          originalPrice,
        );

      if (discountResult) {
        const { discount, discountAmount, finalPrice } = discountResult;

        (variant as any).originalPrice = originalPrice;

        (variant as any).discountedPrice = finalPrice;

        (variant as any).discountAmount = discountAmount;

        (variant as any).discount = {
          id: discount.id,
          code: discount.code,
          type: discount.type,
          value: Number(discount.value),
          maxDiscountAmount:
            discount.maxDiscountAmount != null
              ? Number(discount.maxDiscountAmount)
              : null,
        };
      }
    }

    // =====================================================
    // SORT PRODUCT IMAGES
    // =====================================================

    if (product.colorImages?.length) {
      product.colorImages.sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    // =====================================================
    // SORT SAME COLOR PRODUCT IMAGES
    // =====================================================

    if (product.sameColorProducts?.length) {
      for (const sameProduct of product.sameColorProducts) {
        if (sameProduct.colorImages?.length) {
          sameProduct.colorImages.sort(
            (a, b) => (a.order || 0) - (b.order || 0),
          );
        }
      }
    }

    // =====================================================
    // RAHKARAN SYNC
    // =====================================================

    try {
      // await this.rahkaranService.updateProductStockAndPrice(product.id);

      this.logger.log(`✅ محصول ${product.id} با راهکاران همگام‌سازی شد.`);
    } catch (error) {
      this.logger.error(
        `❌ خطا در همگام‌سازی محصول ${product.id}`,
        error.message,
      );
    }

    // =====================================================
    // RELATED PRODUCTS
    // =====================================================

    let relatedProducts: Product[] = [];

    if (product.categories?.length) {
      const categoryIds = product.categories.map(category => category.id);

      relatedProducts = await this.productRepo
        .createQueryBuilder('p')
        .leftJoin('p.categories', 'cat')
        .leftJoinAndSelect('p.variants', 'variant')
        .leftJoinAndSelect('variant.color', 'color')
        .leftJoinAndSelect('variant.size', 'size')
        .where('cat.id IN (:...categoryIds)', {
          categoryIds,
        })
        .andWhere('p.id != :productId', {
          productId: product.id,
        })
        .orderBy('p.createdAt', 'DESC')
        .take(10)
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
      relations: {
        categories: true,
      },
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

    const oldProductImage = product.image;
    let newProductImage: string | null = null;

    try {
      const { variants, categoryIds, ...simpleFields } = updateProductDto;

      // فایل جدید را ذخیره کن
      if (file) {
        const savedFile = this.filesService.saveFile(file);

        newProductImage = savedFile.filename;
        product.image = newProductImage;
      }

      Object.assign(product, simpleFields);

      await queryRunner.manager.save(product);

      if (variants !== undefined) {
        await this.updateVariants(product.id, variants, queryRunner);
      }

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
          variants: {
            color: true,
            size: true,
          },
          categories: true,
        },
      });

      await queryRunner.commitTransaction();

      // فقط بعد از موفقیت DB
      if (oldProductImage && newProductImage) {
        this.filesService.deleteFile(oldProductImage);
      }

      return updatedProduct;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      // اگر فایل جدید ذخیره شد ولی DB شکست خورد،
      // فایل جدید orphan نشود
      if (newProductImage) {
        this.filesService.deleteFile(newProductImage);
      }

      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ==================== متد کمکی updateVariants ====================

  private async updateVariants(
    productId: number,
    newVariantsDto: {
      id?: number;
      colorId: number;
      sizeId: number;
      price: number;
      stock?: number;
      sku?: string | null;
    }[],
    queryRunner: QueryRunner,
  ) {
    // دریافت واریانت‌های فعلی محصول
    const existingVariants = await queryRunner.manager.find(Variant, {
      where: { productId },
    });

    const existingMap = new Map<number, Variant>();

    for (const variant of existingVariants) {
      existingMap.set(Number(variant.id), variant);
    }

    const toSave: Variant[] = [];

    // چون هر محصول فقط یک رنگ دارد
    const colorIds = [
      ...new Set(
        newVariantsDto.map(dto => Number(dto.colorId)).filter(Boolean),
      ),
    ];

    if (colorIds.length > 1) {
      throw new BadRequestException('هر محصول فقط می‌تواند یک رنگ داشته باشد');
    }

    const finalColorId = colorIds[0];

    // پردازش واریانت‌ها
    for (const dto of newVariantsDto) {
      const variantId =
        dto.id !== undefined && dto.id !== null ? Number(dto.id) : undefined;

      const colorId = Number(dto.colorId);
      const sizeId = Number(dto.sizeId);
      const price = Number(dto.price);
      const stock = Number(dto.stock ?? 0);
      const sku = dto.sku?.trim() || null;

      // واریانت موجود
      if (variantId !== undefined && existingMap.has(variantId)) {
        const existing = existingMap.get(variantId)!;

        existing.colorId = colorId;
        existing.sizeId = sizeId;
        existing.price = price;
        existing.stock = stock;
        existing.sku = sku;

        toSave.push(existing);

        // این واریانت هنوز وجود دارد
        existingMap.delete(variantId);
      } else {
        // واریانت جدید
        const newVariant = queryRunner.manager.create(Variant, {
          productId,
          colorId,
          sizeId,
          price,
          stock,
          sku,
        });

        toSave.push(newVariant);
      }
    }

    // واریانت‌هایی که دیگر ارسال نشده‌اند حذف شوند
    const toRemove = [...existingMap.values()];

    if (toRemove.length > 0) {
      await queryRunner.manager.remove(Variant, toRemove);
    }

    // ذخیره واریانت‌ها
    if (toSave.length > 0) {
      await queryRunner.manager.save(Variant, toSave);
    }

    // =====================================================
    // تغییر رنگ تمام تصاویر محصول
    // =====================================================

    if (finalColorId) {
      // مطمئن شو رنگ وجود دارد
      const color = await queryRunner.manager.findOne(Color, {
        where: {
          id: finalColorId,
        },
      });

      if (!color) {
        throw new BadRequestException(`رنگ با شناسه ${finalColorId} یافت نشد`);
      }

      /*
       * تمام تصاویر محصول، بدون توجه به رنگ قبلی،
       * به رنگ جدید وصل می‌شوند.
       */
      await queryRunner.manager
        .createQueryBuilder()
        .update(ProductColorImage)
        .set({
          color: color,
        })
        .where('product_id = :productId', {
          productId,
        })
        .execute();
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
    newSameColorIds: number[],
  ): Promise<Product> {
    const product = await this.productRepo.findOne({
      where: { id: productId },
      relations: { sameColorProducts: true },
    });
    if (!product) {
      throw new NotFoundException(`محصول با شناسه ${productId} یافت نشد`);
    }

    const uniqueIds = [...new Set(newSameColorIds)].filter(
      id => id !== productId,
    );

    if (uniqueIds.length > 0) {
      const existingProducts = await this.productRepo.findBy({
        id: In(uniqueIds),
      });
      if (existingProducts.length !== uniqueIds.length) {
        throw new BadRequestException(
          'یکی از شناسه‌های محصولات هم‌رنگ نامعتبر است',
        );
      }
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const tableName = 'product_same_color';

      // حذف همه روابط قبلی
      await queryRunner.manager
        .createQueryBuilder()
        .delete()
        .from(tableName)
        .where(
          'product_id = :productId OR same_color_product_id = :productId',
          { productId },
        )
        .execute();

      // درج روابط جدید (متقارن)
      if (uniqueIds.length > 0) {
        const insertValues: {
          product_id: number;
          same_color_product_id: number;
        }[] = [];
        for (const id of uniqueIds) {
          insertValues.push({
            product_id: productId,
            same_color_product_id: id,
          });
          insertValues.push({
            product_id: id,
            same_color_product_id: productId,
          });
        }

        await queryRunner.manager
          .createQueryBuilder()
          .insert()
          .into(tableName)
          .values(insertValues)
          .execute();
      }

      await queryRunner.commitTransaction();

      return this.productRepo.findOneOrFail({
        where: { id: productId },
        relations: { sameColorProducts: true },
      });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
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

    const productImage = product.image;

    const colorImageFiles =
      product.colorImages?.map(image => image.url).filter(Boolean) ?? [];

    // اول DB
    await this.productRepo.delete(id);

    // بعد فایل‌ها
    if (productImage) {
      this.filesService.deleteFile(productImage);
    }

    for (const filename of colorImageFiles) {
      this.filesService.deleteFile(filename);
    }

    return {
      message: 'محصول با موفقیت حذف شد',
    };
  }

  async findAllColors() {
    return this.colorRepo.find();
  }

  async updateColor(id: number, updateColorDto: UpdateColorDto) {
    const color = await this.colorRepo.findOne({ where: { id } });
    if (!color) {
      throw new NotFoundException(`رنگ با شناسه ${id} یافت نشد`);
    }
    Object.assign(color, updateColorDto);
    return this.colorRepo.save(color);
  }

  async deleteColor(id: number) {
    const color = await this.colorRepo.findOne({ where: { id } });
    if (!color) {
      throw new NotFoundException(`رنگ با شناسه ${id} یافت نشد`);
    }
    // بررسی کنید که آیا رنگ در واریانت‌ها استفاده شده است (اختیاری)
    return this.colorRepo.delete(id);
  }

  // ========== مدیریت سایزها ==========
  async findAllSizes() {
    return this.sizeRepo.find();
  }

  async updateSize(id: number, updateSizeDto: UpdateSizeDto) {
    const size = await this.sizeRepo.findOne({ where: { id } });
    if (!size) {
      throw new NotFoundException(`سایز با شناسه ${id} یافت نشد`);
    }
    Object.assign(size, updateSizeDto);
    return this.sizeRepo.save(size);
  }

  async deleteSize(id: number) {
    const size = await this.sizeRepo.findOne({ where: { id } });
    if (!size) {
      throw new NotFoundException(`سایز با شناسه ${id} یافت نشد`);
    }
    return this.sizeRepo.delete(id);
  }

  async getDiscountedProducts(query: QueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const now = new Date();

    const qb = this.productRepo
      .createQueryBuilder('products')

      .leftJoinAndSelect('products.variants', 'variant')
      .leftJoinAndSelect('variant.color', 'color')
      .leftJoinAndSelect('variant.size', 'size')
      .leftJoinAndSelect('products.categories', 'category')
      .leftJoinAndSelect('products.colorImages', 'colorImages')
      .leftJoinAndSelect('colorImages.color', 'imageColor')

      .where(
        `
        EXISTS (
          SELECT 1
          FROM discount_products dp
          INNER JOIN discounts d
            ON d.id = dp.discount_id
          WHERE dp.product_id = products.id
            AND d.isActive = :isActive
            AND d.startsAt <= :now
            AND d.expiresAt >= :now
            AND NOT EXISTS (
              SELECT 1
              FROM discount_users du
              WHERE du.discount_id = d.id
            )
        )
  
        OR
  
        EXISTS (
          SELECT 1
          FROM product_categories pc
          INNER JOIN discount_categories dc
            ON dc.category_id = pc.category_id
          INNER JOIN discounts d2
            ON d2.id = dc.discount_id
          WHERE pc.product_id = products.id
            AND d2.isActive = :isActive
            AND d2.startsAt <= :now
            AND d2.expiresAt >= :now
            AND NOT EXISTS (
              SELECT 1
              FROM discount_users du2
              WHERE du2.discount_id = d2.id
            )
        )
  
        OR
  
        EXISTS (
          SELECT 1
          FROM discounts d3
          WHERE d3.isActive = :isActive
            AND d3.startsAt <= :now
            AND d3.expiresAt >= :now
  
            AND NOT EXISTS (
              SELECT 1
              FROM discount_products dp3
              WHERE dp3.discount_id = d3.id
            )
  
            AND NOT EXISTS (
              SELECT 1
              FROM discount_categories dc3
              WHERE dc3.discount_id = d3.id
            )
  
            AND NOT EXISTS (
              SELECT 1
              FROM discount_users du3
              WHERE du3.discount_id = d3.id
            )
        )
        `,
        {
          isActive: true,
          now,
        },
      );

    applySearch(qb, query.search, [
      'products.title',
      'products.slug',
      'products.productCode',
    ]);

    const { skip, take } = getPagination(page, limit);

    qb.skip(skip).take(take);

    const [data, total] = await qb.getManyAndCount();

    await this.attachDiscounts(data);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  private calculateDiscountedPrice(price: number, discount: Discount) {
    let discountAmount = 0;

    if (discount.type === DiscountType.PERCENTAGE) {
      discountAmount = (price * Number(discount.value)) / 100;
    }

    if (discount.type === DiscountType.FIXED) {
      discountAmount = Number(discount.value);
    }

    if (discount.maxDiscountAmount != null) {
      discountAmount = Math.min(
        discountAmount,
        Number(discount.maxDiscountAmount),
      );
    }

    discountAmount = Math.min(discountAmount, price);

    return Math.max(0, price - discountAmount);
  }

  private async attachDiscounts(products: Product[]) {
    if (!products.length) {
      return products;
    }

    const now = new Date();

    const discounts = await this.discountRepo
      .createQueryBuilder('discount')
      .leftJoinAndSelect('discount.products', 'discountProduct')
      .leftJoinAndSelect('discount.categories', 'discountCategory')
      .where('discount.isActive = :isActive', {
        isActive: true,
      })
      .andWhere('discount.startsAt <= :now', { now })
      .andWhere('discount.expiresAt >= :now', { now })

      // تخفیف‌های user-specific
      .andWhere(qb => {
        const subQuery = qb
          .subQuery()
          .select('1')
          .from('discount_users', 'du')
          .where('du.discount_id = discount.id')
          .getQuery();

        return `NOT EXISTS ${subQuery}`;
      })

      .getMany();

    for (const product of products) {
      const categoryIds =
        product.categories?.map(category => category.id) ?? [];

      const variantPrices =
        product.variants?.map(variant => Number(variant.price)) ?? [];

      if (!variantPrices.length) {
        (product as any).discount = null;
        continue;
      }

      // کمترین قیمت variant را قیمت پایه محصول در نظر می‌گیریم
      const originalPrice = Math.min(...variantPrices);

      const applicableDiscounts = discounts.filter(discount => {
        const discountProductIds = discount.products?.map(p => p.id) ?? [];

        const discountCategoryIds = discount.categories?.map(c => c.id) ?? [];

        // تخفیف عمومی
        if (!discountProductIds.length && !discountCategoryIds.length) {
          return true;
        }

        // مستقیم روی محصول
        if (discountProductIds.includes(product.id)) {
          return true;
        }

        // روی دسته‌بندی محصول
        if (
          discountCategoryIds.some(categoryId =>
            categoryIds.includes(categoryId),
          )
        ) {
          return true;
        }

        return false;
      });

      if (!applicableDiscounts.length) {
        (product as any).discount = null;
        continue;
      }

      let bestDiscount = applicableDiscounts[0];
      let bestDiscountAmount = 0;

      for (const discount of applicableDiscounts) {
        let discountAmount = 0;

        if (discount.type === DiscountType.PERCENTAGE) {
          discountAmount = (originalPrice * Number(discount.value)) / 100;
        } else {
          discountAmount = Number(discount.value);
        }

        if (discount.maxDiscountAmount !== null) {
          discountAmount = Math.min(
            discountAmount,
            Number(discount.maxDiscountAmount),
          );
        }

        discountAmount = Math.min(discountAmount, originalPrice);

        if (discountAmount > bestDiscountAmount) {
          bestDiscountAmount = discountAmount;
          bestDiscount = discount;
        }
      }

      (product as any).discount = {
        id: bestDiscount.id,
        code: bestDiscount.code,
        type: bestDiscount.type,
        value: Number(bestDiscount.value),
        maxDiscountAmount:
          bestDiscount.maxDiscountAmount !== null
            ? Number(bestDiscount.maxDiscountAmount)
            : null,
        discountAmount: bestDiscountAmount,
        originalPrice,
        finalPrice: originalPrice - bestDiscountAmount,
      };
    }

    return products;
  }

  async searchRahkaranProducts(search = '', page = 1, count = 20) {
    const products = await this.rahkaranService.getRetailProducts(
      search,
      page,
      count,
    );

    return {
      data: products,
      pagination: {
        page,
        count,
        hasMore: products.length === count,
      },
    };
  }

  async getRahkaranProductByBarcode(barcode: string) {
    return this.rahkaranService.getRetailProductByBarcode(barcode);
  }

  async syncProductWithRahkaran(productId: number): Promise<Variant[]> {
    const product = await this.productRepo.findOne({
      where: { id: productId },
      relations: {
        variants: true,
      },
    });

    if (!product) {
      throw new NotFoundException(`محصول با شناسه ${productId} یافت نشد`);
    }

    const variants = product.variants ?? [];

    if (!variants.length) {
      return [];
    }

    const variantsToUpdate: Variant[] = [];

    for (const variant of variants) {
      if (!variant.sku?.trim()) {
        continue;
      }

      try {
        const rahkaranProduct =
          await this.rahkaranService.getRetailProductByBarcode(
            variant.sku.trim(),
            1,
            10,
          );

        if (!rahkaranProduct) {
          this.logger.warn(
            `⚠️ محصول راهکاران برای SKU=${variant.sku} پیدا نشد.`,
          );

          continue;
        }

        this.logger.log(rahkaranProduct);

        const newPrice = Number(rahkaranProduct.product?.fee) / 10;
        const newStock = Number(rahkaranProduct.product?.unitRef);

        // جلوگیری از ورود NaN به دیتابیس
        if (!Number.isFinite(newPrice) || !Number.isFinite(newStock)) {
          this.logger.error(
            `❌ مقدار نامعتبر از راهکاران برای SKU=${variant.sku} | ` +
              `fee=${JSON.stringify(rahkaranProduct.fee)} | ` +
              `unitRef=${JSON.stringify(rahkaranProduct.unitRef)} | ` +
              `response=${JSON.stringify(rahkaranProduct)}`,
          );

          continue;
        }

        variant.price = newPrice;
        variant.stock = newStock;

        variantsToUpdate.push(variant);
      } catch (error) {
        this.logger.error(
          `❌ Sync Variant با SKU=${variant.sku} ناموفق بود.`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (variantsToUpdate.length) {
      await this.variantRepo.save(variantsToUpdate);
    }

    return variantsToUpdate;
  }

  async syncAllProductsWithRahkaran(): Promise<void> {
    this.logger.log('🚀 شروع Sync تمام محصولات با راهکاران...');

    const count = 100;
    let page = 1;

    let totalRahkaranProducts = 0;
    let totalMatched = 0;
    let totalUpdated = 0;
    let totalUnchanged = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    try {
      while (true) {
        this.logger.log(`📦 دریافت محصولات راهکاران - page=${page}`);

        const rahkaranProducts = await this.rahkaranService.getRetailProducts(
          '',
          page,
          count,
        );

        if (!rahkaranProducts.length) {
          break;
        }

        totalRahkaranProducts += rahkaranProducts.length;

        // ----------------------------------------------------------
        // Map راهکاران بر اساس productNumber
        // ----------------------------------------------------------

        const rahkaranMap = new Map<string, RahkaranProduct>();

        for (const rahkaranProduct of rahkaranProducts) {
          const sku = this.normalizeSku(rahkaranProduct.productNumber);

          if (!sku) {
            totalSkipped++;
            continue;
          }

          rahkaranMap.set(sku, rahkaranProduct);
        }

        const skus = [...rahkaranMap.keys()];

        if (!skus.length) {
          if (rahkaranProducts.length < count) {
            break;
          }

          page++;
          continue;
        }

        // ----------------------------------------------------------
        // فقط Variantهای موجود در سایت
        // ----------------------------------------------------------
        //
        // مهم:
        // این Query هیچ Variant جدیدی ایجاد نمی‌کند.
        // بنابراین محصولی که فقط در راهکاران وجود دارد
        // وارد سایت نمی‌شود.
        // ----------------------------------------------------------

        const variants = await this.variantRepo
          .createQueryBuilder('variant')
          .where('variant.sku IN (:...skus)', {
            skus,
          })
          .getMany();

        this.logger.log(
          `🔎 page=${page} | ` +
            `Rahkaran=${rahkaranProducts.length} | ` +
            `SiteVariants=${variants.length}`,
        );

        const variantsToUpdate: Variant[] = [];

        // ----------------------------------------------------------
        // Match و آماده‌سازی Update
        // ----------------------------------------------------------

        for (const variant of variants) {
          const sku = this.normalizeSku(variant.sku);

          if (!sku) {
            totalSkipped++;
            continue;
          }

          const rahkaranProduct = rahkaranMap.get(sku);

          if (!rahkaranProduct) {
            totalSkipped++;
            continue;
          }

          totalMatched++;

          // --------------------------------------------------------
          // fee -> price
          // unitRef -> stock
          // --------------------------------------------------------

          const newPrice = Number(rahkaranProduct.fee) / 10;

          const newStock = Number(rahkaranProduct.unitRef);

          // --------------------------------------------------------
          // جلوگیری از NaN / Infinity
          // --------------------------------------------------------

          if (!Number.isFinite(newPrice)) {
            totalFailed++;

            this.logger.error(
              `❌ قیمت نامعتبر | ` +
                `VariantID=${variant.id} | ` +
                `SKU=${sku} | ` +
                `fee=${JSON.stringify(rahkaranProduct.fee)}`,
            );

            continue;
          }

          if (!Number.isFinite(newStock)) {
            totalFailed++;

            this.logger.error(
              `❌ موجودی نامعتبر | ` +
                `VariantID=${variant.id} | ` +
                `SKU=${sku} | ` +
                `unitRef=${JSON.stringify(rahkaranProduct.unitRef)}`,
            );

            continue;
          }

          // --------------------------------------------------------
          // جلوگیری از مقدار خارج از محدوده Number
          // --------------------------------------------------------

          if (!Number.isSafeInteger(newStock)) {
            totalFailed++;

            this.logger.error(
              `❌ stock خارج از محدوده امن Number | ` +
                `VariantID=${variant.id} | ` +
                `SKU=${sku} | ` +
                `stock=${newStock}`,
            );

            continue;
          }

          // --------------------------------------------------------
          // بررسی تغییر
          // --------------------------------------------------------

          const oldPrice = Number(variant.price);
          const oldStock = Number(variant.stock);

          const priceChanged = oldPrice !== newPrice;

          const stockChanged = oldStock !== newStock;

          if (!priceChanged && !stockChanged) {
            totalUnchanged++;
            continue;
          }

          variant.price = newPrice;
          variant.stock = newStock;

          variantsToUpdate.push(variant);
        }

        // ----------------------------------------------------------
        // Save با Chunk
        // ----------------------------------------------------------

        if (variantsToUpdate.length) {
          const chunkSize = 100;

          for (let i = 0; i < variantsToUpdate.length; i += chunkSize) {
            const chunk = variantsToUpdate.slice(i, i + chunkSize);

            try {
              await this.variantRepo.save(chunk, {
                chunk: chunkSize,
                transaction: true,
              });

              totalUpdated += chunk.length;

              this.logger.log(`💾 page=${page} | ` + `Saved=${chunk.length}`);
            } catch (chunkError) {
              // ----------------------------------------------------
              // اگر یک Chunk مشکل داشت،
              // کل Sync متوقف نشود.
              // ----------------------------------------------------

              this.logger.error(
                `❌ خطا در ذخیره Chunk | ` +
                  `page=${page} | ` +
                  `size=${chunk.length}`,
                chunkError instanceof Error
                  ? chunkError.stack
                  : String(chunkError),
              );

              // ----------------------------------------------------
              // ذخیره یکی‌یکی برای پیدا کردن Variant مشکل‌دار
              // ----------------------------------------------------

              for (const variant of chunk) {
                try {
                  await this.variantRepo.save(variant);

                  totalUpdated++;
                } catch (variantError) {
                  totalFailed++;

                  this.logger.error(
                    `❌ خطا در ذخیره Variant | ` +
                      `ID=${variant.id} | ` +
                      `SKU=${variant.sku} | ` +
                      `price=${variant.price} | ` +
                      `stock=${variant.stock}`,
                    variantError instanceof Error
                      ? variantError.message
                      : String(variantError),
                  );
                }
              }
            }
          }
        }

        // ----------------------------------------------------------
        // صفحه آخر
        // ----------------------------------------------------------

        if (rahkaranProducts.length < count) {
          break;
        }

        page++;
      }

      // ------------------------------------------------------------
      // Final Log
      // ------------------------------------------------------------

      this.logger.log(
        `✅ Sync تمام محصولات با راهکاران تمام شد | ` +
          `Pages=${page} | ` +
          `RahkaranProducts=${totalRahkaranProducts} | ` +
          `Matched=${totalMatched} | ` +
          `Updated=${totalUpdated} | ` +
          `Unchanged=${totalUnchanged} | ` +
          `Skipped=${totalSkipped} | ` +
          `Failed=${totalFailed}`,
      );
    } catch (error) {
      this.logger.error(
        '❌ خطای کلی در Sync تمام محصولات با راهکاران',
        error instanceof Error ? error.stack : String(error),
      );

      throw error;
    }
  }

  private normalizeSku(value: string | null | undefined): string {
    if (!value) {
      return '';
    }

    return value
      .trim()
      .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
      .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
  }
}
