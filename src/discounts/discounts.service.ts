import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cart } from 'src/cart/entities/cart.entity';
import { Category } from 'src/categories/entities/category.entity';
import { Product } from 'src/products/entities/product.entity';
import { User } from 'src/users/entities/user.entity';
import { In, Repository } from 'typeorm';

import { CreateDiscountDto } from './dto/create-discount.dto';
import { UpdateDiscountDto } from './dto/update-discount.dto';
import { Discount, DiscountType } from './entities/discount.entity';
import { DiscountUsage } from './entities/discount-code-usage.entity';

@Injectable()
export class DiscountService {
  constructor(
    @InjectRepository(Discount)
    private readonly discountRepo: Repository<Discount>,

    @InjectRepository(DiscountUsage)
    private readonly usageRepo: Repository<DiscountUsage>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,

    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,

    @InjectRepository(Cart)
    private readonly cartRepo: Repository<Cart>,
  ) {}

  // =========================================================
  // CREATE
  // =========================================================

  async create(dto: CreateDiscountDto) {
    const existing = await this.discountRepo.findOne({
      where: {
        code: dto.code.trim().toUpperCase(),
      },
    });

    if (existing) {
      throw new BadRequestException('این کد تخفیف قبلاً ثبت شده است.');
    }

    const startsAt = new Date(dto.startsAt);
    const expiresAt = new Date(dto.expiresAt);

    if (expiresAt <= startsAt) {
      throw new BadRequestException('تاریخ پایان باید بعد از تاریخ شروع باشد.');
    }

    if (dto.type === DiscountType.PERCENTAGE && dto.value > 100) {
      throw new BadRequestException('درصد تخفیف نمی‌تواند بیشتر از 100 باشد.');
    }

    const users = dto.userIds?.length
      ? await this.userRepo.find({
          where: {
            id: In(dto.userIds),
          },
        })
      : [];

    const categories = dto.categoryIds?.length
      ? await this.categoryRepo.find({
          where: {
            id: In(dto.categoryIds),
          },
        })
      : [];

    const products = dto.productIds?.length
      ? await this.productRepo.find({
          where: {
            id: In(dto.productIds),
          },
        })
      : [];

    if (dto.userIds?.length && users.length !== dto.userIds.length) {
      throw new BadRequestException('بعضی از کاربران انتخاب‌شده وجود ندارند.');
    }

    if (
      dto.categoryIds?.length &&
      categories.length !== dto.categoryIds.length
    ) {
      throw new BadRequestException(
        'بعضی از دسته‌بندی‌های انتخاب‌شده وجود ندارند.',
      );
    }

    if (dto.productIds?.length && products.length !== dto.productIds.length) {
      throw new BadRequestException('بعضی از محصولات انتخاب‌شده وجود ندارند.');
    }

    const discount = this.discountRepo.create({
      code: dto.code.trim().toUpperCase(),

      type: dto.type,

      value: dto.value,

      maxDiscountAmount: dto.maxDiscountAmount ?? null,

      minOrderAmount: dto.minOrderAmount ?? null,

      startsAt,

      expiresAt,

      isActive: dto.isActive ?? true,

      users,

      categories,

      products,
    });

    return this.discountRepo.save(discount);
  }

  // =========================================================
  // FIND ALL
  // =========================================================

  async findAll() {
    return this.discountRepo.find({
      order: {
        createdAt: 'DESC',
      },
    });
  }

  // =========================================================
  // FIND ONE
  // =========================================================

  async findOne(id: number) {
    const discount = await this.discountRepo.findOne({
      where: { id },
      relations: {
        users: true,
        categories: true,
        products: true,
      },
    });

    if (!discount) {
      throw new NotFoundException('کد تخفیف پیدا نشد.');
    }

    return discount;
  }

  // =========================================================
  // UPDATE
  // =========================================================

  async update(id: number, dto: UpdateDiscountDto) {
    const discount = await this.discountRepo.findOne({
      where: { id },
      relations: {
        users: true,
        categories: true,
        products: true,
      },
    });

    if (!discount) {
      throw new NotFoundException('کد تخفیف پیدا نشد.');
    }

    if (dto.code) {
      const code = dto.code.trim().toUpperCase();

      const duplicate = await this.discountRepo.findOne({
        where: {
          code,
        },
      });

      if (duplicate && duplicate.id !== discount.id) {
        throw new BadRequestException('این کد تخفیف قبلاً ثبت شده است.');
      }

      discount.code = code;
    }

    if (dto.type !== undefined) {
      discount.type = dto.type;
    }

    if (dto.value !== undefined) {
      if (discount.type === DiscountType.PERCENTAGE && dto.value > 100) {
        throw new BadRequestException(
          'درصد تخفیف نمی‌تواند بیشتر از 100 باشد.',
        );
      }

      discount.value = dto.value;
    }

    if (dto.maxDiscountAmount !== undefined) {
      discount.maxDiscountAmount = dto.maxDiscountAmount;
    }

    if (dto.minOrderAmount !== undefined) {
      discount.minOrderAmount = dto.minOrderAmount;
    }

    if (dto.startsAt !== undefined) {
      discount.startsAt = new Date(dto.startsAt);
    }

    if (dto.expiresAt !== undefined) {
      discount.expiresAt = new Date(dto.expiresAt);
    }

    if (discount.expiresAt <= discount.startsAt) {
      throw new BadRequestException('تاریخ پایان باید بعد از تاریخ شروع باشد.');
    }

    if (dto.isActive !== undefined) {
      discount.isActive = dto.isActive;
    }

    if (dto.userIds !== undefined) {
      discount.users = dto.userIds.length
        ? await this.userRepo.find({
            where: {
              id: In(dto.userIds),
            },
          })
        : [];
    }

    if (dto.categoryIds !== undefined) {
      discount.categories = dto.categoryIds.length
        ? await this.categoryRepo.find({
            where: {
              id: In(dto.categoryIds),
            },
          })
        : [];
    }

    if (dto.productIds !== undefined) {
      discount.products = dto.productIds.length
        ? await this.productRepo.find({
            where: {
              id: In(dto.productIds),
            },
          })
        : [];
    }

    return this.discountRepo.save(discount);
  }

  // =========================================================
  // DELETE
  // =========================================================

  async remove(id: number) {
    const discount = await this.discountRepo.findOne({
      where: { id },
    });

    if (!discount) {
      throw new NotFoundException('کد تخفیف پیدا نشد.');
    }

    await this.discountRepo.remove(discount);

    return {
      message: 'کد تخفیف با موفقیت حذف شد.',
    };
  }

  // =========================================================
  // FIND DISCOUNT BY CODE
  // =========================================================

  async findByCode(code: string) {
    const discount = await this.discountRepo.findOne({
      where: {
        code: code.trim().toUpperCase(),
      },
      relations: {
        users: true,
        categories: true,
        products: true,
      },
    });

    if (!discount) {
      throw new BadRequestException('کد تخفیف معتبر نیست.');
    }

    return discount;
  }

  // =========================================================
  // CHECK USER
  // =========================================================

  private isUserAllowed(discount: Discount, userId: number): boolean {
    // Discount عمومی است
    if (!discount.users || discount.users.length === 0) {
      return true;
    }

    // Discount اختصاصی است
    return discount.users.some(user => user.id === userId);
  }

  // =========================================================
  // CALCULATE DISCOUNT
  // =========================================================

  private calculateDiscountAmount(discount: Discount, amount: number) {
    let discountAmount = 0;

    if (discount.type === DiscountType.PERCENTAGE) {
      discountAmount = (amount * Number(discount.value)) / 100;
    }

    if (discount.type === DiscountType.FIXED) {
      discountAmount = Number(discount.value);
    }

    if (discount.maxDiscountAmount) {
      discountAmount = Math.min(
        discountAmount,
        Number(discount.maxDiscountAmount),
      );
    }

    discountAmount = Math.min(discountAmount, amount);

    return Math.max(0, discountAmount);
  }

  // =========================================================
  // VALIDATE DISCOUNT
  // =========================================================

  async validateDiscount(
    code: string,
    userId: number,
    amount: number,
    items: {
      productId: number;
      quantity: number;
      price: number;
      categoryIds: number[];
    }[],
  ) {
    const discount = await this.findByCode(code);

    const now = new Date();

    // =====================================================
    // 1. فعال بودن
    // =====================================================

    if (!discount.isActive) {
      throw new BadRequestException('این کد تخفیف فعال نیست.');
    }

    // =====================================================
    // 2. تاریخ اعتبار
    // =====================================================

    if (now < discount.startsAt) {
      throw new BadRequestException(
        'زمان استفاده از این کد تخفیف هنوز شروع نشده است.',
      );
    }

    if (now > discount.expiresAt) {
      throw new BadRequestException(
        'زمان استفاده از این کد تخفیف به پایان رسیده است.',
      );
    }

    // =====================================================
    // 3. Product / Category Discount
    // =====================================================

    const hasProductRestriction = discount.products?.length > 0;

    const hasCategoryRestriction = discount.categories?.length > 0;

    if (hasProductRestriction || hasCategoryRestriction) {
      throw new BadRequestException('این کد تخفیف فعال نیست.');
    }

    // =====================================================
    // 4. User restriction
    // =====================================================

    if (discount.users?.length > 0) {
      const userAllowed = discount.users.some(user => user.id === userId);

      if (!userAllowed) {
        throw new BadRequestException(
          'این کد تخفیف برای شما قابل استفاده نیست.',
        );
      }
    }

    // =====================================================
    // 5. قبلاً استفاده شده
    // =====================================================

    const usage = await this.usageRepo.findOne({
      where: {
        discount: {
          id: discount.id,
        },
        user: {
          id: userId,
        },
      },
    });

    if (usage) {
      throw new BadRequestException('این کد تخفیف را قبلاً استفاده کرده‌اید.');
    }

    // =====================================================
    // 6. حداقل مبلغ
    // =====================================================

    if (
      discount.minOrderAmount !== null &&
      amount < Number(discount.minOrderAmount)
    ) {
      throw new BadRequestException(
        `حداقل مبلغ سفارش برای استفاده از این کد ${Number(
          discount.minOrderAmount,
        ).toLocaleString()} تومان است.`,
      );
    }

    // =====================================================
    // 7. محاسبه تخفیف
    // =====================================================

    const discountAmount = this.calculateDiscountAmount(discount, amount);

    return {
      discount,
      discountAmount,
    };
  }

  // =========================================================
  // CONSUME DISCOUNT
  // =========================================================

  async consumeDiscount(discountId: number, userId: number, orderId: number) {
    const existing = await this.usageRepo.findOne({
      where: {
        discount: {
          id: discountId,
        },
        user: {
          id: userId,
        },
      },
    });

    if (existing) {
      return existing;
    }

    const usage = this.usageRepo.create({
      discount: {
        id: discountId,
      } as Discount,

      user: {
        id: userId,
      } as User,

      order: {
        id: orderId,
      },
    });

    try {
      return await this.usageRepo.save(usage);
    } catch (error) {
      /**
       * Unique(discount,user)
       *
       * اگر همزمان دو درخواست پرداخت موفق برسند،
       * دیتابیس درخواست دوم را رد می‌کند.
       */
      const alreadyUsed = await this.usageRepo.findOne({
        where: {
          discount: {
            id: discountId,
          },
          user: {
            id: userId,
          },
        },
      });

      if (alreadyUsed) {
        return alreadyUsed;
      }

      throw error;
    }
  }

  async getBestDiscountForProduct(
    productId: number,
    categoryIds: number[],
    originalPrice: number,
  ): Promise<{
    discount: Discount;
    discountAmount: number;
    finalPrice: number;
  } | null> {
    const now = new Date();

    const discounts = await this.discountRepo
      .createQueryBuilder('discount')
      .leftJoinAndSelect('discount.products', 'product')
      .leftJoinAndSelect('discount.categories', 'category')
      .where('discount.isActive = :isActive', {
        isActive: true,
      })
      .andWhere('discount.startsAt <= :now', { now })
      .andWhere('discount.expiresAt >= :now', { now })

      // فقط تخفیف‌های عمومی
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

    const applicableDiscounts = discounts.filter(discount => {
      const productIds = discount.products?.map(p => p.id) ?? [];

      const discountCategoryIds = discount.categories?.map(c => c.id) ?? [];

      const hasProductRestriction = productIds.length > 0;
      const hasCategoryRestriction = discountCategoryIds.length > 0;

      // بدون محدودیت => روی همه محصولات
      if (!hasProductRestriction && !hasCategoryRestriction) {
        return true;
      }

      // محصول مستقیم
      if (hasProductRestriction && productIds.includes(productId)) {
        return true;
      }

      // دسته‌بندی
      if (
        hasCategoryRestriction &&
        discountCategoryIds.some(id => categoryIds.includes(id))
      ) {
        return true;
      }

      return false;
    });

    if (!applicableDiscounts.length) {
      return null;
    }

    // پیدا کردن بیشترین تخفیف واقعی
    let bestDiscount: {
      discount: Discount;
      discountAmount: number;
      finalPrice: number;
    } | null = null;

    for (const discount of applicableDiscounts) {
      const discountAmount = this.calculateDiscountAmount(
        discount,
        originalPrice,
      );

      const finalPrice = Math.max(0, originalPrice - discountAmount);

      if (!bestDiscount || discountAmount > bestDiscount.discountAmount) {
        bestDiscount = {
          discount,
          discountAmount,
          finalPrice,
        };
      }
    }

    return bestDiscount;
  }

  async getActiveDiscountsForProducts(productIds: number[]) {
    if (!productIds.length) {
      return [];
    }

    const now = new Date();

    const discounts = await this.discountRepo
      .createQueryBuilder('discount')
      .leftJoinAndSelect('discount.products', 'product')
      .leftJoinAndSelect('discount.categories', 'category')
      .where('discount.isActive = :isActive', {
        isActive: true,
      })
      .andWhere('discount.startsAt <= :now', { now })
      .andWhere('discount.expiresAt >= :now', { now })

      // تخفیف‌هایی که مخصوص user هستند در لیست عمومی نباشند
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

    return discounts;
  }

  calculateProductDiscount(discount: Discount, originalPrice: number) {
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

    discountAmount = Math.max(0, discountAmount);

    return {
      originalPrice,
      discountAmount,
      finalPrice: originalPrice - discountAmount,
    };
  }

  async applyDiscountToCart(userId: number, code: string) {
    const cart = await this.cartRepo.findOne({
      where: {
        user: {
          id: userId,
        },
      },
      relations: {
        items: {
          variant: {
            product: {
              categories: true,
            },
          },
        },
      },
    });

    if (!cart || !cart.items?.length) {
      throw new BadRequestException('سبد خرید خالی است.');
    }

    const items = cart.items.map(item => ({
      productId: item.variant.product.id,
      quantity: item.quantity,
      price: Number(item.variant.price),
      categoryIds:
        item.variant.product.categories?.map(category => category.id) ?? [],
    }));

    const totalPrice = items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    const result = await this.validateDiscount(
      code.trim().toUpperCase(),
      userId,
      totalPrice,
      items,
    );

    const discountAmount = Number(result.discountAmount);

    const finalPrice = Math.max(0, totalPrice - discountAmount);

    return {
      discount: {
        id: result.discount.id,
        code: result.discount.code,
        type: result.discount.type,
        value: Number(result.discount.value),
      },

      summary: {
        originalPrice: totalPrice,
        discountPrice: discountAmount,
        finalPrice,
      },
    };
  }
}
