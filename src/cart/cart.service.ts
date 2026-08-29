// src/carts/carts.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DiscountService } from 'src/discounts/discounts.service';
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

    private readonly discountService: DiscountService,
  ) {}

  // یافتن یا ایجاد سبد خرید (با userId یا guestId)
  async getOrCreateCart(userId?: number, guestId?: string): Promise<Cart> {
    if (userId) {
      let cart = await this.cartRepo.findOne({
        where: {
          user: { id: userId },
        },
        relations: {
          items: {
            variant: {
              color: true,
              size: true,
              product: {
                categories: true,
              },
            },
          },
        },
      });

      if (!cart) {
        cart = this.cartRepo.create({
          user: { id: userId },
        });

        await this.cartRepo.save(cart);
      }

      return cart;
    }

    if (guestId) {
      let cart = await this.cartRepo.findOne({
        where: { guestId },
        relations: {
          items: {
            variant: {
              color: true,
              size: true,
              product: {
                categories: true,
              },
            },
          },
        },
      });

      if (!cart) {
        cart = this.cartRepo.create({ guestId });
        await this.cartRepo.save(cart);
      }

      return cart;
    }

    throw new BadRequestException('Either userId or guestId is required');
  }

  // دریافت سبد خرید
  async getCart(userId?: number, guestId?: string): Promise<Cart> {
    if (userId) {
      let cart = await this.cartRepo.findOne({
        where: { user: { id: userId } },
        relations: {
          items: {
            variant: {
              color: true,
              size: true,
              product: {
                categories: true,
              },
            },
          },
        },
      });

      if (!cart) {
        cart = this.cartRepo.create({
          user: { id: userId },
        });

        await this.cartRepo.save(cart);
      }

      return this.applyDiscountsToCart(cart);
    }

    if (guestId) {
      let cart = await this.cartRepo.findOne({
        where: { guestId },
        relations: {
          items: {
            variant: {
              color: true,
              size: true,
              product: {
                categories: true,
              },
            },
          },
        },
      });

      if (!cart) {
        cart = this.cartRepo.create({ guestId });
        await this.cartRepo.save(cart);
      }

      return this.applyDiscountsToCart(cart);
    }

    throw new BadRequestException('Either userId or guestId is required');
  }

  // اضافه کردن آیتم به سبد خرید
  async addToCart(
    userId: number | undefined,
    guestId: string | undefined,
    dto: AddToCartDto,
  ): Promise<Cart> {
    const cart = await this.getOrCreateCart(userId, guestId);

    const variant = await this.variantRepo.findOne({
      where: { id: dto.variantId },
      relations: {
        color: true,
        size: true,
        product: {
          categories: true,
        },
      },
    });

    if (!variant) {
      throw new NotFoundException('واریانت یافت نشد');
    }

    if (variant.stock < dto.quantity) {
      throw new BadRequestException('موجودی کافی نیست');
    }

    const existingItem = cart.items.find(
      item => item.variant.id === dto.variantId,
    );

    if (existingItem) {
      if (variant.stock < existingItem.quantity + dto.quantity) {
        throw new BadRequestException('موجودی کافی نیست');
      }
      existingItem.quantity += dto.quantity;
      await this.cartItemRepo.save(existingItem);
    } else {
      const newItem = this.cartItemRepo.create({
        cart,
        variant,
        quantity: dto.quantity,
      });
      await this.cartItemRepo.save(newItem);
    }

    return this.getCart(userId, guestId);
  }

  // به‌روزرسانی تعداد آیتم
  async updateItemQuantity(
    userId: number | undefined,
    guestId: string | undefined,
    itemId: number,
    dto: UpdateCartItemDto,
  ): Promise<Cart> {
    const cart = await this.getOrCreateCart(userId, guestId);
    const item = cart.items.find(i => i.id === itemId);

    if (!item) {
      throw new NotFoundException('آیتم در سبد خرید یافت نشد');
    }

    if (dto.quantity <= 0) {
      await this.cartItemRepo.remove(item);
    } else {
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

    return this.getCart(userId, guestId);
  }

  // حذف آیتم از سبد خرید
  async removeItem(
    userId: number | undefined,
    guestId: string | undefined,
    itemId: number,
  ): Promise<Cart> {
    const cart = await this.getOrCreateCart(userId, guestId);
    const item = cart.items.find(i => i.id === itemId);

    if (!item) {
      throw new NotFoundException('آیتم در سبد خرید یافت نشد');
    }

    await this.cartItemRepo.remove(item);
    return this.getCart(userId, guestId);
  }

  // خالی کردن سبد خرید
  async clearCart(userId: number, guestId?: string): Promise<void> {
    const cart = await this.getCart(userId, guestId);
    await this.cartItemRepo.delete({ cart: { id: cart.id } });
  }

  // ادغام سبد مهمان با حساب کاربری
  async mergeGuestCart(userId: number, guestId: string): Promise<void> {
    const guestCart = await this.cartRepo.findOne({
      where: { guestId },
      relations: {
        items: {
          variant: true,
        },
      },
    });
    if (!guestCart || guestCart.items.length === 0) return;

    let userCart = await this.cartRepo.findOne({
      where: { user: { id: userId } },
      relations: {
        items: {
          variant: true,
        },
      },
    });
    if (!userCart) {
      userCart = this.cartRepo.create({ user: { id: userId } });
      await this.cartRepo.save(userCart);
    }

    for (const guestItem of guestCart.items) {
      const existing = userCart.items.find(
        item => item.variant.id === guestItem.variant.id,
      );
      if (existing) {
        existing.quantity += guestItem.quantity;
      } else {
        guestItem.cart = userCart;
        userCart.items.push(guestItem);
      }
    }

    await this.cartRepo.save(userCart);
    await this.cartRepo.remove(guestCart);
  }

  private async applyDiscountsToCart(cart: Cart) {
    let originalPrice = 0;
    let discountPrice = 0;
    let finalPrice = 0;

    for (const item of cart.items ?? []) {
      const variant = item.variant;

      if (!variant?.product) {
        continue;
      }

      const itemOriginalPrice = Number(variant.price);
      const quantity = item.quantity;

      const itemOriginalTotal = itemOriginalPrice * quantity;

      const categoryIds =
        variant.product.categories?.map(category => category.id) ?? [];

      const result = await this.discountService.getBestDiscountForProduct(
        variant.product.id,
        categoryIds,
        itemOriginalPrice,
      );

      let itemDiscountPrice = 0;
      let itemFinalPrice = itemOriginalPrice;

      if (result) {
        itemDiscountPrice = Number(result.discountAmount);
        itemFinalPrice = Number(result.finalPrice);

        (variant as any).discount = {
          id: result.discount.id,
          code: result.discount.code,
          type: result.discount.type,
          value: Number(result.discount.value),
          maxDiscountAmount:
            result.discount.maxDiscountAmount != null
              ? Number(result.discount.maxDiscountAmount)
              : null,
          discountAmount: itemDiscountPrice,
        };
      } else {
        (variant as any).discount = null;
      }

      const itemFinalTotal = itemFinalPrice * quantity;
      const itemDiscountTotal = itemDiscountPrice * quantity;

      // برای نمایش قیمت هر محصول
      (variant as any).originalPrice = itemOriginalPrice;
      (variant as any).discountedPrice = itemFinalPrice;

      // جمع کل سبد
      originalPrice += itemOriginalTotal;
      discountPrice += itemDiscountTotal;
      finalPrice += itemFinalTotal;
    }

    return {
      ...cart,

      pricing: {
        originalPrice,
        discountPrice,
        finalPrice,
      },
    };
  }
}
