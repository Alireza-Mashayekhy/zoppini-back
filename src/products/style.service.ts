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
import { Variant } from './entities/variant.entity';
import { findInStockProductColorPairs } from './utils/stock.util';

@Injectable()
export class StyleService {
  constructor(
    @InjectRepository(StyleProduct)
    private styleRepo: Repository<StyleProduct>,
    @InjectRepository(Product)
    private productRepo: Repository<Product>,
    @InjectRepository(Color)
    private colorRepo: Repository<Color>,
    @InjectRepository(Variant)
    private variantRepo: Repository<Variant>,
  ) {}

  async getStyleProducts(options?: {
    onlyInStock?: boolean;
  }): Promise<StyleProduct[]> {
    const onlyInStock = options?.onlyInStock ?? false;

    const styleProducts = await this.styleRepo.find({
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
      return styleProducts;
    }

    // فقط محصول‌رنگ‌هایی که حداقل یک variant موجود دارند
    const inStockPairs = await findInStockProductColorPairs(
      this.variantRepo,
      styleProducts.map(item => ({
        productId: item.productId,
        colorId: item.colorId,
      })),
    );

    return styleProducts.filter(item =>
      inStockPairs.has(`${item.productId}-${item.colorId}`),
    );
  }

  async getStyleProduct(
    id: number,
    options?: { onlyInStock?: boolean },
  ): Promise<StyleProduct> {
    const onlyInStock = options?.onlyInStock ?? false;

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
