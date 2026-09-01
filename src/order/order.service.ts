// src/orders/orders.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Address } from 'src/address/entities/address.entity';
import { Cart } from 'src/cart/entities/cart.entity';
import { ClubService } from 'src/club/club.service';
import { applySearch, getPagination, QueryDto } from 'src/common/query';
import { DiscountService } from 'src/discounts/discounts.service';
import { Discount } from 'src/discounts/entities/discount.entity';
import { DiscountUsage } from 'src/discounts/entities/discount-code-usage.entity';
import { Variant } from 'src/products/entities/variant.entity';
import { RahkaranService } from 'src/rahkaran/rahkaran.service';
import { SmsService } from 'src/sms/sms.service';
import { User } from 'src/users/entities/user.entity';
import { DataSource, In, Not, Repository } from 'typeorm';

import { CreateOrderDto, ShippingMethod } from './dto/create-order.dto';
import { Order, OrderStatus } from './entities/order.entity';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    @InjectRepository(Address)
    private readonly addressRepo: Repository<Address>,

    @InjectRepository(Cart)
    private readonly cartRepo: Repository<Cart>,

    @InjectRepository(Discount)
    private readonly discountRepo: Repository<Discount>,

    @InjectRepository(DiscountUsage)
    private readonly discountUsageRepo: Repository<DiscountUsage>,

    private readonly rahkaranService: RahkaranService,

    private readonly clubService: ClubService,

    private readonly discountService: DiscountService,

    private readonly smsService: SmsService,

    private readonly dataSource: DataSource,
  ) {}

  // تولید شماره سفارش منحصربه‌فرد
  private generateOrderNumber(): string {
    const prefix = 'ORD';
    const timestamp = Date.now().toString().slice(-8);
    const random = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, '0');
    return `${prefix}-${timestamp}-${random}`;
  }

  async createOrder(userId: number, dto: CreateOrderDto) {
    // =====================================================
    // 1. User
    // =====================================================

    const user = await this.userRepo.findOne({
      where: {
        id: userId,
      },
    });

    if (!user) {
      throw new NotFoundException('کاربر یافت نشد.');
    }

    // =====================================================
    // 2. Address
    // =====================================================

    const address = await this.addressRepo.findOne({
      where: {
        id: dto.addressId,
        user: {
          id: userId,
        },
      },
    });

    if (!address) {
      throw new BadRequestException('آدرس انتخاب‌شده معتبر نیست.');
    }

    // =====================================================
    // 3. Cart
    // =====================================================

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

    // =====================================================
    // 4. محاسبه قیمت محصولات
    // =====================================================

    let totalPrice = 0;

    const orderItems = cart.items.map(item => {
      const price = Number(item.variant.price);

      const itemTotal = price * item.quantity;

      totalPrice += itemTotal;

      return {
        variant: item.variant,
        quantity: item.quantity,
        price,
        totalPrice: itemTotal,
      };
    });

    // =====================================================
    // 5. هزینه ارسال
    // =====================================================

    const shippingCost = this.calculateShippingCost(dto.shippingMethod);

    // =====================================================
    // 6. تخفیف
    // =====================================================

    const discountItems = cart.items.map(item => ({
      productId: item.variant.product.id,
      quantity: item.quantity,
      price: Number(item.variant.price),
      categoryIds:
        item.variant.product.categories?.map(category => category.id) ?? [],
    }));

    let discountAmount = 0;
    let discountId: number | null = null;
    let discountCode: string | null = null;

    if (dto.discountCode?.trim()) {
      const result = await this.discountService.validateDiscount(
        dto.discountCode.trim(),
        userId,
        totalPrice,
        discountItems,
      );

      discountAmount = Number(result.discountAmount);

      discountId = result.discount.id;

      discountCode = result.discount.code;
    }

    // =====================================================
    // 7. مبلغ نهایی
    // =====================================================

    const finalPrice = Math.max(
      0,
      totalPrice + Number(shippingCost) - discountAmount,
    );

    // =====================================================
    // 8. ساخت Order
    // =====================================================

    const order = this.orderRepo.create({
      orderNumber: this.generateOrderNumber(),

      user,

      items: orderItems,

      totalPrice,

      shippingCost: Number(shippingCost),

      discount: discountAmount,

      finalPrice,

      discountId,

      discountCode,

      addressId: address.id,

      address,

      note: dto.note ?? null,

      shippingMethod: dto.shippingMethod,

      status: OrderStatus.PENDING,
    });

    // =====================================================
    // 9. ذخیره سفارش
    // =====================================================

    const savedOrder = await this.orderRepo.save(order);

    // =====================================================
    // 10. سبد خرید فعلاً پاک نمی‌شود
    // =====================================================

    // این کار باید بعد از پرداخت موفق انجام شود.
    //
    // await this.cartService.clearCart(userId);

    return savedOrder;
  }

  async confirmOrderPayment(orderId: number): Promise<Order> {
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const order = await queryRunner.manager.findOne(Order, {
        where: { id: orderId },
        relations: {
          user: true,
          items: {
            variant: {
              product: true,
              color: true,
              size: true,
            },
          },
        },
      });

      if (!order) {
        throw new NotFoundException('سفارش یافت نشد');
      }

      // بسیار مهم برای callback تکراری
      if (order.status !== OrderStatus.PENDING) {
        throw new BadRequestException('فقط سفارشات در انتظار قابل تأیید هستند');
      }

      const userId = order.user.id;

      // =========================================================
      // 1. کاهش موجودی
      // =========================================================

      for (const item of order.items) {
        const variant = await queryRunner.manager.findOne(Variant, {
          where: {
            id: item.variant.id,
          },
          relations: {
            product: true,
          },
        });

        if (!variant) {
          throw new NotFoundException(`واریانت ${item.variant.id} یافت نشد`);
        }

        if (variant.stock < item.quantity) {
          throw new BadRequestException(
            `موجودی کافی نیست برای ${variant.product?.title || 'محصول'}`,
          );
        }

        await queryRunner.manager.update(
          Variant,
          { id: variant.id },
          {
            stock: () => `stock - ${item.quantity}`,
          },
        );
      }

      // =========================================================
      // 2. ثبت مصرف کد تخفیف
      // =========================================================

      if (order.discountCode) {
        const discount = await queryRunner.manager.findOne(Discount, {
          where: {
            code: order.discountCode,
          },
        });

        if (!discount) {
          throw new BadRequestException('کد تخفیف سفارش یافت نشد');
        }

        // بررسی اینکه این کاربر قبلاً این کد را مصرف نکرده
        const existingUsage = await queryRunner.manager.findOne(DiscountUsage, {
          where: {
            discount: {
              id: discount.id,
            },
            user: {
              id: userId,
            },
          },
        });

        if (existingUsage) {
          throw new BadRequestException(
            'این کد تخفیف قبلاً توسط کاربر استفاده شده است',
          );
        }

        const usage = queryRunner.manager.create(DiscountUsage, {
          discount,
          user: order.user,
          order,
        });

        await queryRunner.manager.save(DiscountUsage, usage);

        await queryRunner.manager.save(Discount, discount);
      }

      // =========================================================
      // 3. خالی کردن سبد خرید
      // =========================================================

      const cart = await queryRunner.manager.findOne(Cart, {
        where: {
          user: {
            id: userId,
          },
        },
      });

      if (cart) {
        await queryRunner.manager.delete('cart_item', {
          cart: {
            id: cart.id,
          },
        });
      }

      // =========================================================
      // 4. تغییر وضعیت سفارش
      // =========================================================

      order.status = OrderStatus.PAID;

      await queryRunner.manager.save(Order, order);

      // =========================================================
      // 5. Commit
      // =========================================================

      await queryRunner.commitTransaction();

      // =========================================================
      // 6. ثبت فاکتور فروش در راهکاران
      // =========================================================

      try {
        const rahkaranInvoice = await this.rahkaranService.syncOrderToRahkaran(
          await this.findOne(order.id),
        );

        this.logger.log(
          `✅ سفارش ${order.id} در راهکاران ثبت شد. ` +
            `Invoice ID: ${
              rahkaranInvoice?.id ?? rahkaranInvoice?.invoiceId ?? 'unknown'
            }`,
        );
      } catch (error) {
        this.logger.error(
          `❌ ثبت فاکتور سفارش ${order.id} در راهکاران ناموفق بود.`,
          error instanceof Error ? error.stack : String(error),
        );

        // فعلاً سفارش سایت PAID باقی می‌ماند.
        //
        // چون تراکنش دیتابیس سایت قبلاً commit شده،
        // نمی‌توانیم rollback کنیم.
        //
        // بعداً برای این قسمت retry/outbox اضافه می‌کنیم.
      }

      try {
        await this.clubService.createInvoice({
          customerCode: order.user.phone,
          finalPrice: order.finalPrice,
        });

        this.logger.log(`✅ سفارش ${order.id} در دایاتک ثبت شد. `);
      } catch (error) {
        this.logger.error(
          `❌ ثبت فاکتور سفارش ${order.id} در دایاتک ناموفق بود.`,
          error instanceof Error ? error.stack : String(error),
        );

        // فعلاً سفارش سایت PAID باقی می‌ماند.
        //
        // چون تراکنش دیتابیس سایت قبلاً commit شده،
        // نمی‌توانیم rollback کنیم.
        //
        // بعداً برای این قسمت retry/outbox اضافه می‌کنیم.
      }

      await this.smsService.sendOrderConfirmationToCustomer(order.user.phone);
      await this.smsService.sendOrderNotificationToAdmin(order.id.toString());

      return this.findOne(order.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // لغو سفارش به دلیل عدم موفقیت پرداخت (بدون تغییر موجودی)
  async failOrderPayment(orderId: number): Promise<Order> {
    const order = await this.orderRepo.findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException('سفارش یافت نشد');
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('فقط سفارشات در انتظار قابل لغو هستند');
    }

    order.status = OrderStatus.CANCELLED;
    await this.orderRepo.save(order);
    return this.findOne(order.id);
  }

  // دریافت یک سفارش
  async findOne(id: number, userId?: number): Promise<Order> {
    const where: any = { id };
    if (userId) {
      where.user = { id: userId };
    }
    const order = await this.orderRepo.findOne({
      where,
      relations: {
        user: true,
        items: {
          variant: {
            color: true,
            size: true,
            product: true,
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException('سفارش یافت نشد');
    }
    return order;
  }

  async findAll(
    userId: number,
    query: QueryDto,
  ): Promise<{ data: Order[]; pagination: any; stats: any }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    // ۱. دریافت داده‌های صفحه‌بندی‌شده
    const qb = this.orderRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('items.variant', 'variant')
      .leftJoinAndSelect('variant.color', 'color')
      .leftJoinAndSelect('variant.size', 'size')
      .leftJoinAndSelect('variant.product', 'product')
      .where('order.user = :userId', { userId })
      .orderBy('order.createdAt', 'DESC');

    const { skip, take } = getPagination(page, limit);
    qb.skip(skip).take(take);

    const [data, total] = await qb.getManyAndCount();

    // ۲. محاسبه آمار
    const totalCount = await this.orderRepo.count({
      where: { user: { id: userId } },
    });

    const cancelledCount = await this.orderRepo.count({
      where: { user: { id: userId }, status: OrderStatus.CANCELLED },
    });

    const deliveredCount = await this.orderRepo.count({
      where: { user: { id: userId }, status: OrderStatus.DELIVERED },
    });

    const inProgressCount = await this.orderRepo.count({
      where: {
        user: { id: userId },
        status: Not(In([OrderStatus.CANCELLED, OrderStatus.DELIVERED])),
      },
    });

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      stats: {
        total: totalCount,
        cancelled: cancelledCount,
        delivered: deliveredCount,
        inProgress: inProgressCount,
      },
    };
  }

  // لغو سفارش (فقط اگر pending باشد)
  async cancelOrder(id: number, userId: number): Promise<Order> {
    const order = await this.findOne(id, userId);

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('فقط سفارشات در انتظار قابل لغو هستند');
    }

    // برگرداندن موجودی
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      order.status = OrderStatus.CANCELLED;
      await queryRunner.manager.save(order);

      await queryRunner.commitTransaction();
      return this.findOne(id, userId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // (برای ادمین) تغییر وضعیت سفارش
  async updateStatus(id: number, status: OrderStatus): Promise<Order> {
    const order = await this.orderRepo.findOne({ where: { id } });
    if (!order) {
      throw new NotFoundException('سفارش یافت نشد');
    }

    order.status = status;
    await this.orderRepo.save(order);

    return this.orderRepo.findOneOrFail({
      where: { id },
      relations: {
        items: {
          variant: {
            color: true,
            size: true,
            product: true,
          },
        },
        user: true,
      },
    });
  }

  // محاسبه تعداد سفارشات کاربر
  async countUserOrders(userId: number): Promise<number> {
    return this.orderRepo.count({
      where: { user: { id: userId } },
    });
  }

  async findAllForAdmin(query: QueryDto): Promise<{
    data: Order[];
    pagination: any;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.orderRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('items.variant', 'variant')
      .leftJoinAndSelect('variant.color', 'color')
      .leftJoinAndSelect('variant.size', 'size')
      .leftJoinAndSelect('variant.product', 'product')
      .leftJoinAndSelect('order.user', 'user')
      .orderBy('order.createdAt', 'DESC');

    applySearch(qb, query.search, [
      'order.orderNumber',
      'user.fullName',
      'user.phone',
      'order.status',
    ]);

    // =========================
    // Pagination
    // =========================

    const { skip, take } = getPagination(page, limit);

    qb.skip(skip).take(take);

    const [data, total] = await qb.getManyAndCount();

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

  // دریافت یک سفارش برای شروع پرداخت - با بررسی مالکیت کاربر
  // (اگر سفارش متعلق به کاربر نباشد، همان «یافت نشد» برمی‌گردد تا وجود سفارش افشا نشود)
  async findOneForPayment(id: number, userId: number): Promise<Order> {
    const order = await this.orderRepo.findOne({
      where: {
        id,
        user: {
          id: userId,
        },
      },
      relations: {
        user: true,
        address: {
          city: true,
          province: true,
        },
        items: {
          variant: {
            color: true,
            size: true,
            product: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('سفارش یافت نشد');
    }

    return order;
  }

  // دریافت یک سفارش بدون فیلتر کاربر - برای ادمین
  async findOneForAdmin(id: number): Promise<Order> {
    const order = await this.orderRepo.findOne({
      where: { id },
      relations: {
        user: true,
        address: {
          city: true,
          province: true,
        },
        items: {
          variant: {
            color: true,
            size: true,
            product: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('سفارش یافت نشد');
    }

    return order;
  }

  // لغو سفارش توسط ادمین (با ثبت دلیل)
  async adminCancelOrder(id: number, reason?: string): Promise<Order> {
    const order = await this.findOneForAdmin(id);

    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('این سفارش قبلاً لغو شده است');
    }

    // برگرداندن موجودی
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      order.status = OrderStatus.CANCELLED;
      // می‌توانید دلیل لغو را در فیلدی مثل `note` ذخیره کنید
      if (reason) {
        order.note = order.note
          ? `${order.note}\nدلیل لغو توسط ادمین: ${reason}`
          : `دلیل لغو توسط ادمین: ${reason}`;
      }
      await queryRunner.manager.save(order);

      await queryRunner.commitTransaction();
      return this.findOneForAdmin(id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private calculateShippingCost(shippingMethod: ShippingMethod): number {
    switch (shippingMethod) {
      case ShippingMethod.POST:
        return 170000;

      case ShippingMethod.COURIER:
        return 100000;

      case ShippingMethod.TIBAX:
        return 120000;

      default:
        return 0;
    }
  }
}
