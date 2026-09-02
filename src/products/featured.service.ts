// src/featured/featured.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Product } from 'src/products/entities/product.entity';
import { Color } from 'src/products/entities/product-color.entity';
import { Repository } from 'typeorm';

import {
  CreateFeaturedProductDto,
  UpdateFeaturedProductDto,
} from './dto/create-featured-product.dto';
import { FeaturedProduct } from './entities/featured-product.entity';
import { Variant } from './entities/variant.entity';
import { findInStockProductColorPairs } from './utils/stock.util';

@Injectable()
export class FeaturedService {
  constructor(
    @InjectRepository(FeaturedProduct)
    private featuredRepo: Repository<FeaturedProduct>,
    @InjectRepository(Product)
    private productRepo: Repository<Product>,
    @InjectRepository(Color)
    private colorRepo: Repository<Color>,
    @InjectRepository(Variant)
    private variantRepo: Repository<Variant>,
  ) {}

  async getFeaturedProducts(options?: {
    onlyInStock?: boolean;
  }): Promise<FeaturedProduct[]> {
    const onlyInStock = options?.onlyInStock ?? false;

    const featured = await this.featuredRepo.find({
      relations: {
        product: {
          variants: {
            color: true,
            size: true,
          },
          colorImages: {
            color: true,
          },
        },
        color: true,
      },
      order: { order: 'ASC', createdAt: 'ASC' },
    });

    if (!onlyInStock) {
      return featured;
    }

    // فقط محصول‌رنگ‌هایی که حداقل یک variant موجود دارند
    const inStockPairs = await findInStockProductColorPairs(
      this.variantRepo,
      featured.map(item => ({
        productId: item.productId,
        colorId: item.colorId,
      })),
    );

    return featured.filter(item =>
      inStockPairs.has(`${item.productId}-${item.colorId}`),
    );
  }

  async getFeaturedProduct(
    id: number,
    options?: { onlyInStock?: boolean },
  ): Promise<FeaturedProduct> {
    const onlyInStock = options?.onlyInStock ?? false;

    const item = await this.featuredRepo.findOne({
      where: { id },
      relations: {
        product: {
          variants: {
            color: true,
            size: true,
          },
          colorImages: true,
        },
        color: true,
      },
    });
    if (!item) {
      throw new NotFoundException('محصول ویژه یافت نشد');
    }

    if (onlyInStock) {
      const inStockPairs = await findInStockProductColorPairs(
        this.variantRepo,
        [{ productId: item.productId, colorId: item.colorId }],
      );

      if (!inStockPairs.has(`${item.productId}-${item.colorId}`)) {
        throw new NotFoundException('محصول ویژه یافت نشد');
      }
    }

    return item;
  }

  async createFeaturedProduct(
    dto: CreateFeaturedProductDto,
  ): Promise<FeaturedProduct> {
    const product = await this.productRepo.findOne({
      where: { id: dto.productId },
    });
    if (!product) {
      throw new NotFoundException('محصول یافت نشد');
    }

    const color = await this.colorRepo.findOne({ where: { id: dto.colorId } });
    if (!color) {
      throw new NotFoundException('رنگ یافت نشد');
    }

    const existing = await this.featuredRepo.findOne({
      where: {
        productId: dto.productId,
        colorId: dto.colorId,
      },
    });
    if (existing) {
      throw new ConflictException(
        'این ترکیب محصول و رنگ قبلاً به لیست ویژه اضافه شده است',
      );
    }

    const featured = this.featuredRepo.create({
      productId: dto.productId,
      colorId: dto.colorId,
      order: dto.order || 0,
    });

    return this.featuredRepo.save(featured);
  }

  async updateFeaturedProduct(
    id: number,
    dto: UpdateFeaturedProductDto,
  ): Promise<FeaturedProduct> {
    const featured = await this.featuredRepo.findOne({ where: { id } });
    if (!featured) {
      throw new NotFoundException('محصول ویژه یافت نشد');
    }

    if (dto.order !== undefined) {
      featured.order = dto.order;
    }

    return this.featuredRepo.save(featured);
  }

  async deleteFeaturedProduct(id: number): Promise<void> {
    const result = await this.featuredRepo.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException('محصول ویژه یافت نشد');
    }
  }

  async deleteFeaturedProductByProductAndColor(
    productId: number,
    colorId: number,
  ): Promise<void> {
    const result = await this.featuredRepo.delete({
      productId,
      colorId,
    });
    if (result.affected === 0) {
      throw new NotFoundException('محصول ویژه یافت نشد');
    }
  }
}
