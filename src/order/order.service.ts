// src/orders/orders.service.ts
import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Address } from 'src/address/entities/address.entity';
import { Cart } from 'src/cart/entities/cart.entity';
import { getPagination, QueryDto } from 'src/common/query';
import { Variant } from 'src/products/entities/variant.entity';
import { RahkaranService } from 'src/rahkaran/rahkaran.service';
import { SmsService } from 'src/sms/sms.service';
import { User } from 'src/users/entities/user.entity';
import { DataSource, In, Not, Repository } from 'typeorm';

import { CreateOrderDto, ShippingMethod } from './dto/create-order.dto';
import { Order, OrderStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order)
    private orderRepo: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemRepo: Repository<OrderItem>,
    @InjectRepository(Cart)
    private cartRepo: Repository<Cart>,
    private dataSource: DataSource,
    private readonly smsService: SmsService,
    @Inject(forwardRef(() => RahkaranService)) // ⬅️ این خط
    private readonly rahkaranService: RahkaranService,
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

  // ایجاد سفارش از سبد خرید
  async createOrder(userId: number, dto: CreateOrderDto): Promise<Order> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // ۱. دریافت سبد خرید
      const cart = await queryRunner.manager.findOne(Cart, {
        where: { user: { id: userId } },
        relations: {
          items: {
            variant: {
              product: true,
              color: true,
              size: true,
            },
          },
        },
      });

      const user = await queryRunner.manager.findOne(User, {
        where: { id: userId },
      });
      if (!user) throw new NotFoundException('کاربر یافت نشد');
      if (!cart) throw new NotFoundException('سبد خرید یافت نشد');
      if (cart.items.length === 0)
        throw new BadRequestException('سبد خرید خالی است');

      // ۲. دریافت آدرس
      const address = await queryRunner.manager.findOne(Address, {
        where: { id: dto.addressId, userId },
        relations: { city: true, province: true },
      });
      if (!address) throw new NotFoundException('آدرس یافت نشد');

      // ۳. محاسبه قیمت‌ها و ایجاد آیتم‌های سفارش
      let totalPrice = 0;
      const orderItems: OrderItem[] = [];
      for (const cartItem of cart.items) {
        const itemTotal = cartItem.variant.price * cartItem.quantity;
        totalPrice += itemTotal;
        const orderItem = queryRunner.manager.create(OrderItem, {
          variant: cartItem.variant,
          quantity: cartItem.quantity,
          price: cartItem.variant.price,
          totalPrice: itemTotal,
        });
        orderItems.push(orderItem);
      }

      // ۴. محاسبه هزینه ارسال
      const isTehran = address.city.name === 'تهران';
      let shippingCost = 0;
      switch (dto.shippingMethod) {
        case ShippingMethod.POST:
          shippingCost = 170000;
          break;
        case ShippingMethod.COURIER:
          if (!isTehran)
            throw new BadRequestException('پیک فقط در تهران قابل انتخاب است');
          shippingCost = 0;
          break;
        case ShippingMethod.TIBAX:
          if (!isTehran)
            throw new BadRequestException(
              'تیباکس فقط در تهران قابل انتخاب است',
            );
          shippingCost = 0;
          break;
        default:
          throw new BadRequestException('روش ارسال نامعتبر');
      }

      const discount = dto.discount || 0;
      const finalPrice = totalPrice + shippingCost - discount;
      if (finalPrice < 0)
        throw new BadRequestException('قیمت نهایی نمی‌تواند منفی باشد');

      // ۵. ایجاد سفارش (بدون تغییر موجودی و بدون خالی کردن سبد)
      const order = queryRunner.manager.create(Order, {
        orderNumber: this.generateOrderNumber(),
        user: { id: userId },
        addressId: dto.addressId,
        shippingMethod: dto.shippingMethod,
        totalPrice,
        shippingCost,
        discount,
        finalPrice,
        status: OrderStatus.PENDING, // همچنان در انتظار پرداخت
        note: dto.note,
        items: orderItems,
      });
      await queryRunner.manager.save(order);

      // (اختیاری) sync با راهکاران را می‌توانیم بعد از پرداخت موفق انجام دهیم
      // فعلاً آن را کامنت می‌کنیم یا به متد confirmOrderPayment منتقل می‌کنیم

      await queryRunner.commitTransaction();
      return this.findOne(order.id, userId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async confirmOrderPayment(orderId: number): Promise<Order> {
    const order = await this.orderRepo.findOne({
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
    if (!order) throw new NotFoundException('سفارش یافت نشد');
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('فقط سفارشات در انتظار قابل تأیید هستند');
    }

    const userId = order.user.id;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // کاهش موجودی
      for (const item of order.items) {
        // استفاده از کلاس Variant به‌جای رشته
        const variant = await queryRunner.manager.findOne(Variant, {
          where: { id: item.variant.id },
        });
        if (!variant) {
          throw new NotFoundException(`واریانت ${item.variant.id} یافت نشد`);
        }
        if (variant.stock < item.quantity) {
          throw new BadRequestException(
            `موجودی کافی نیست برای ${item.variant.product?.title || 'محصول'}`,
          );
        }
        await queryRunner.manager.update(
          Variant,
          { id: item.variant.id },
          { stock: () => `stock - ${item.quantity}` },
        );
      }

      // خالی کردن سبد خرید
      const cart = await queryRunner.manager.findOne(Cart, {
        where: { user: { id: userId } },
      });
      if (cart) {
        await queryRunner.manager.delete('cart_item', {
          cart: { id: cart.id },
        });
      }

      order.status = OrderStatus.PAID;
      await queryRunner.manager.save(order);

      // (اختیاری) همگام‌سازی با راهکاران
      this.rahkaranService
        .syncOrderToRahkaran(order.id)
        .then(rahkaranOrderId => {
          this.logger.log(
            `✅ سفارش ${order.id} در راهکاران با شناسه ${rahkaranOrderId} ثبت شد.`,
          );
        })
        .catch(err => {
          this.logger.error(
            `❌ خطا در ثبت سفارش ${order.id} در راهکاران`,
            err.message,
          );
        });

      await queryRunner.commitTransaction();
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
      for (const item of order.items) {
        await queryRunner.manager.update(
          'variant',
          { id: item.variant.id },
          { stock: () => `stock + ${item.quantity}` },
        );
      }

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

  async findAllForAdmin(): Promise<Order[]> {
    return this.orderRepo.find({
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
      order: { createdAt: 'DESC' },
    });
  }

  // دریافت یک سفارش بدون فیلتر کاربر - برای ادمین
  async findOneForAdmin(id: number): Promise<Order> {
    return this.orderRepo
      .findOneOrFail({
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
      })
      .catch(() => {
        throw new NotFoundException('سفارش یافت نشد');
      });
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
      for (const item of order.items) {
        await queryRunner.manager.update(
          'variant',
          { id: item.variant.id },
          { stock: () => `stock + ${item.quantity}` },
        );
      }

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
}
