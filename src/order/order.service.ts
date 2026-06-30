// src/orders/orders.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Address } from 'src/address/entities/address.entity';
import { Cart } from 'src/cart/entities/cart.entity';
import { DataSource, Repository } from 'typeorm';

import { CreateOrderDto, ShippingMethod } from './dto/create-order.dto';
import { Order, OrderStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private orderRepo: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemRepo: Repository<OrderItem>,
    @InjectRepository(Cart)
    private cartRepo: Repository<Cart>,
    private dataSource: DataSource,
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
      // ۱. دریافت سبد خرید با روابط کامل
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

      console.log(cart, userId);
      if (!cart) {
        throw new NotFoundException('سبد خرید یافت نشد');
      }
      if (cart.items.length === 0) {
        throw new BadRequestException('سبد خرید خالی است');
      }

      // ۲. دریافت آدرس
      const address = await queryRunner.manager.findOne(Address, {
        where: { id: dto.addressId, userId },
        relations: { city: true, province: true },
      });
      if (!address) {
        throw new NotFoundException('آدرس یافت نشد');
      }

      // ۳. محاسبه قیمت‌ها و ایجاد آیتم‌های سفارش
      let totalPrice = 0;
      const orderItems: OrderItem[] = [];
      for (const cartItem of cart.items) {
        if (cartItem.variant.stock < cartItem.quantity) {
          throw new BadRequestException(
            `موجودی محصول ${cartItem.variant.product.title} (${cartItem.variant.color?.name} - ${cartItem.variant.size?.name}) کافی نیست`,
          );
        }
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
          shippingCost = isTehran ? 170000 : 250000;
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
      if (finalPrice < 0) {
        throw new BadRequestException('قیمت نهایی نمی‌تواند منفی باشد');
      }

      // ۵. ایجاد سفارش
      const order = queryRunner.manager.create(Order, {
        orderNumber: this.generateOrderNumber(),
        user: { id: userId },
        addressId: dto.addressId,
        shippingMethod: dto.shippingMethod,
        totalPrice,
        shippingCost,
        discount,
        finalPrice,
        status: OrderStatus.PENDING,
        note: dto.note,
        items: orderItems,
      });
      await queryRunner.manager.save(order);

      // ۶. کاهش موجودی
      for (const cartItem of cart.items) {
        await queryRunner.manager.update(
          'variant',
          { id: cartItem.variant.id },
          { stock: () => `stock - ${cartItem.quantity}` },
        );
      }

      // ۷. خالی کردن سبد
      await queryRunner.manager.delete('cart_item', { cart: { id: cart.id } });

      await queryRunner.commitTransaction();
      return this.findOne(order.id, userId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // دریافت یک سفارش
  async findOne(id: number, userId: number): Promise<Order> {
    return this.orderRepo
      .findOneOrFail({
        where: { id, user: { id: userId } },
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

  // دریافت لیست سفارشات کاربر
  async findAll(userId: number): Promise<Order[]> {
    return this.orderRepo.find({
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
      order: { createdAt: 'DESC' },
    });
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
