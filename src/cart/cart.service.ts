import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Variant } from 'src/products/entities/variant.entity';
import { Repository } from 'typeorm';

import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { Cart } from './entities/cart.entity';
import { CartItem } from './entities/cart-item.entity';

@Injectable()
export class CartsService {
  constructor(
    @InjectRepository(Cart)
    private cartRepo: Repository<Cart>,
    @InjectRepository(CartItem)
    private cartItemRepo: Repository<CartItem>,
    @InjectRepository(Variant)
    private variantRepo: Repository<Variant>,
  ) {}

  // یافتن یا ایجاد سبد خرید برای کاربر
  async getOrCreateCart(userId: number): Promise<Cart> {
    let cart = await this.cartRepo.findOne({
      where: { user: { id: userId } },
      relations: {
        items: {
          variant: {
            color: true,
            size: true,
            product: true,
          },
        },
      },
    });

    if (!cart) {
      cart = this.cartRepo.create({ user: { id: userId } });
      await this.cartRepo.save(cart);
    }

    return cart;
  }

  // دریافت سبد خرید با روابط کامل
  async getCart(userId: number): Promise<Cart> {
    const cart = await this.cartRepo.findOne({
      where: { user: { id: userId } },
      relations: {
        items: {
          variant: {
            color: true,
            size: true,
            product: true,
          },
        },
      },
    });

    if (!cart) {
      throw new NotFoundException('سبد خرید یافت نشد');
    }

    return cart;
  }

  // اضافه کردن آیتم به سبد خرید
  async addToCart(userId: number, dto: AddToCartDto): Promise<Cart> {
    const cart = await this.getOrCreateCart(userId);

    // بررسی موجودی واریانت
    const variant = await this.variantRepo.findOne({
      where: { id: dto.variantId },
      relations: {
        color: true,
        size: true,
        product: true,
      },
    });

    if (!variant) {
      throw new NotFoundException('واریانت یافت نشد');
    }

    if (variant.stock < dto.quantity) {
      throw new BadRequestException('موجودی کافی نیست');
    }

    // بررسی آیا آیتم قبلاً در سبد خرید وجود دارد
    const existingItem = cart.items.find(
      item => item.variant.id === dto.variantId,
    );

    if (existingItem) {
      // افزایش تعداد
      if (variant.stock < existingItem.quantity + dto.quantity) {
        throw new BadRequestException('موجودی کافی نیست');
      }
      existingItem.quantity += dto.quantity;
      await this.cartItemRepo.save(existingItem);
    } else {
      // ایجاد آیتم جدید
      const newItem = this.cartItemRepo.create({
        cart,
        variant,
        quantity: dto.quantity,
      });
      await this.cartItemRepo.save(newItem);
    }

    return this.getCart(userId);
  }

  // به‌روزرسانی تعداد آیتم
  async updateItemQuantity(
    userId: number,
    itemId: number,
    dto: UpdateCartItemDto,
  ): Promise<Cart> {
    const cart = await this.getOrCreateCart(userId);
    const item = cart.items.find(i => i.id === itemId);

    if (!item) {
      throw new NotFoundException('آیتم در سبد خرید یافت نشد');
    }

    if (dto.quantity <= 0) {
      // حذف آیتم
      await this.cartItemRepo.remove(item);
    } else {
      // بررسی موجودی
      const variant = await this.variantRepo.findOne({
        where: { id: item.variant.id },
      });

      if (!variant) {
        throw new NotFoundException('واریانت یافت نشد');
      }

      if (variant.stock < dto.quantity) {
        throw new BadRequestException('موجودی کافی نیست');
      }

      item.quantity = dto.quantity;
      await this.cartItemRepo.save(item);
    }

    return this.getCart(userId);
  }

  // حذف آیتم از سبد خرید
  async removeItem(userId: number, itemId: number): Promise<Cart> {
    const cart = await this.getOrCreateCart(userId);
    const item = cart.items.find(i => i.id === itemId);

    if (!item) {
      throw new NotFoundException('آیتم در سبد خرید یافت نشد');
    }

    await this.cartItemRepo.remove(item);
    return this.getCart(userId);
  }

  // خالی کردن سبد خرید
  async clearCart(userId: number): Promise<void> {
    const cart = await this.getCart(userId);
    await this.cartItemRepo.delete({ cart: { id: cart.id } });
  }
}
