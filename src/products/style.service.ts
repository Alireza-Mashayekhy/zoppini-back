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

import { CreateSuggestedProductDto } from './dto/create-suggested-style.dto';
import { StyleProduct } from './entities/style-product.entity';

@Injectable()
export class StyleService {
  constructor(
    @InjectRepository(StyleProduct)
    private styleRepo: Repository<StyleProduct>,
    @InjectRepository(Product)
    private productRepo: Repository<Product>,
    @InjectRepository(Color)
    private colorRepo: Repository<Color>,
  ) {}

  async getStyleProducts(): Promise<StyleProduct[]> {
    return this.styleRepo.find({
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

  async getStyleProduct(id: number): Promise<StyleProduct> {
    const item = await this.styleRepo.findOne({
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

  async createStyleProduct(
    dto: CreateSuggestedProductDto,
  ): Promise<StyleProduct> {
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

    const existing = await this.styleRepo.findOne({
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

    const style = this.styleRepo.create({
      productId: dto.productId,
      colorId: dto.colorId,
      order: dto.order || 0,
      faTitle: dto.faTitle,
      enTitle: dto.enTitle,
    });

    return this.styleRepo.save(style);
  }

  async updateStyleProduct(
    id: number,
    dto: CreateSuggestedProductDto,
  ): Promise<StyleProduct> {
    const style = await this.styleRepo.findOne({ where: { id } });
    if (!style) {
      throw new NotFoundException('محصول ویژه یافت نشد');
    }

    if (dto.order !== undefined) {
      style.order = dto.order;
    }

    return this.styleRepo.save(style);
  }

  async deleteStyleProduct(id: number): Promise<void> {
    const result = await this.styleRepo.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException('محصول ویژه یافت نشد');
    }
  }

  async deleteStyleProductProductByProductAndColor(
    productId: number,
    colorId: number,
  ): Promise<void> {
    const result = await this.styleRepo.delete({
      productId,
      colorId,
    });
    if (result.affected === 0) {
      throw new NotFoundException('محصول ویژه یافت نشد');
    }
  }
}
