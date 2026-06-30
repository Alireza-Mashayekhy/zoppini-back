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

@Injectable()
export class FeaturedService {
  constructor(
    @InjectRepository(FeaturedProduct)
    private featuredRepo: Repository<FeaturedProduct>,
    @InjectRepository(Product)
    private productRepo: Repository<Product>,
    @InjectRepository(Color)
    private colorRepo: Repository<Color>,
  ) {}

  async getFeaturedProducts(): Promise<FeaturedProduct[]> {
    return this.featuredRepo.find({
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
  }

  async getFeaturedProduct(id: number): Promise<FeaturedProduct> {
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
