// src/wishlist/wishlist.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Product } from 'src/products/entities/product.entity';
import { Repository } from 'typeorm';

import { AddToWishlistDto } from './dto/create-wishlist.dto';
import { Wishlist } from './entities/wishlist.entity';

@Injectable()
export class WishlistService {
  constructor(
    @InjectRepository(Wishlist)
    private wishlistRepo: Repository<Wishlist>,
    @InjectRepository(Product)
    private productRepo: Repository<Product>,
  ) {}

  // دریافت لیست علاقه‌مندی‌های کاربر
  async getUserWishlist(userId: number): Promise<Wishlist[]> {
    return this.wishlistRepo.find({
      where: { user: { id: userId } },
      relations: {
        product: {
          variants: {
            color: true,
            size: true,
          },
          colorImages: true,
        },
      },
      order: { createdAt: 'DESC' },
    });
  }

  // دریافت محصولات علاقه‌مندی کاربر (به‌همراه اطلاعات کامل)
  async getUserWishlistProducts(userId: number): Promise<Product[]> {
    const wishlist = await this.wishlistRepo.find({
      where: { user: { id: userId } },
      relations: {
        product: true,
      },
    });
    return wishlist.map(item => item.product);
  }

  // بررسی اینکه آیا محصول در لیست علاقه‌مندی کاربر وجود دارد
  async isProductInWishlist(
    userId: number,
    productId: number,
  ): Promise<boolean> {
    const count = await this.wishlistRepo.count({
      where: { user: { id: userId }, product: { id: productId } },
    });
    return count > 0;
  }

  // اضافه کردن به علاقه‌مندی‌ها
  async addToWishlist(
    userId: number,
    dto: AddToWishlistDto,
  ): Promise<Wishlist> {
    const { productId } = dto;

    // بررسی وجود محصول
    const product = await this.productRepo.findOne({
      where: { id: productId },
      relations: {
        variants: true,
        colorImages: true,
      },
    });
    if (!product) {
      throw new NotFoundException('محصول یافت نشد');
    }

    // بررسی تکراری نبودن
    const existing = await this.wishlistRepo.findOne({
      where: { user: { id: userId }, product: { id: productId } },
    });
    if (existing) {
      throw new ConflictException(
        'این محصول قبلاً به علاقه‌مندی‌ها اضافه شده است',
      );
    }

    const wishlistItem = this.wishlistRepo.create({
      user: { id: userId },
      product,
    });

    return this.wishlistRepo.save(wishlistItem);
  }

  // حذف از علاقه‌مندی‌ها
  async removeFromWishlist(userId: number, productId: number): Promise<void> {
    const result = await this.wishlistRepo.delete({
      user: { id: userId },
      product: { id: productId },
    });

    if (result.affected === 0) {
      throw new NotFoundException('این محصول در لیست علاقه‌مندی‌ها یافت نشد');
    }
  }

  // دریافت تعداد علاقه‌مندی‌های کاربر
  async countUserWishlist(userId: number): Promise<number> {
    return this.wishlistRepo.count({
      where: { user: { id: userId } },
    });
  }
}
