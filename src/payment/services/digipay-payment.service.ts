// src/payment/services/digipay-payment.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { OrdersService } from 'src/order/order.service';
import { Repository } from 'typeorm';

import {
  Payment,
  PaymentGateway,
  PaymentStatus,
} from '../entities/payment.entity';
import { DigipayAuthService } from './digipay-auth.service';

@Injectable()
export class DigipayPaymentService {
  private readonly logger = new Logger(DigipayPaymentService.name);

  constructor(
    private configService: ConfigService,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
    private ordersService: OrdersService,
    private authService: DigipayAuthService,
  ) {}

  async requestPayment(
    orderId: number,
  ): Promise<{ refId: string; payUrl: string }> {
    const order = await this.ordersService.findOneForAdmin(orderId);
    if (!order) {
      throw new BadRequestException('سفارش یافت نشد');
    }

    const existingPayment = await this.paymentRepo.findOne({
      where: { orderId, gateway: PaymentGateway.DIGIPAY },
    });
    if (existingPayment && existingPayment.status === PaymentStatus.PENDING) {
      throw new BadRequestException('درخواست پرداخت قبلاً ثبت شده است');
    }

    const accessToken = await this.authService.getAccessToken();
    const apiUrl = this.configService.get<string>('DIGIPAY_API_URL')!;
    const callbackUrl = this.configService.get<string>(
      'DIGIPAY_PAYMENT_CALLBACK_URL',
    )!;
    const providerId = `ORDER-${orderId}-${Date.now()}`;
    const amount = Math.round(order.finalPrice * 10); // تبدیل به ریال

    const payload = {
      amount: amount,
      cellNumber: order.user?.phone || '',
      providerId: providerId,
      callbackUrl: callbackUrl,
      preferredGateway: 2, // 2 برای IPG
    };

    try {
      const response = await fetch(`${apiUrl}/tickets/business?type=11`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          Agent: 'WEB',
          'Digipay-Version': '2022-02-02',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (data.result?.status !== 0) {
        throw new BadRequestException(
          data.result?.message || 'خطا در ایجاد تیکت خرید',
        );
      }

      const ticket = data.ticket; // شناسه تیکت
      const payUrl = data.payUrl; // آدرس هدایت کاربر به درگاه پرداخت

      // ذخیره اطلاعات پرداخت
      const payment = this.paymentRepo.create({
        orderId,
        refId: ticket, // استفاده از ticket به عنوان refId
        amount,
        gateway: PaymentGateway.DIGIPAY,
        status: PaymentStatus.PENDING,
        resCode: '0',
        gatewayResponse: data,
      });
      await this.paymentRepo.save(payment);

      return { refId: ticket, payUrl };
    } catch (error) {
      this.logger.error(error.message, error.stack);
      throw new BadRequestException('خطا در ارتباط با درگاه دیجی‌پی');
    }
  }

  async verifyPayment(
    ticket: string,
  ): Promise<{ success: boolean; message: string; orderId?: number }> {
    // ۱. پیدا کردن پرداخت بر اساس ticket
    const payment = await this.paymentRepo.findOne({
      where: { refId: ticket, gateway: PaymentGateway.DIGIPAY },
    });
    if (!payment) {
      throw new NotFoundException('تراکنش یافت نشد');
    }

    // ۲. اگر قبلاً موفق بوده، برگردان
    if (payment.status === PaymentStatus.SUCCESS) {
      return {
        success: true,
        message: 'پرداخت قبلاً تأیید شده است',
        orderId: payment.orderId,
      };
    }

    // ۳. استعلام وضعیت از دیجی‌پی
    const accessToken = await this.authService.getAccessToken();
    const apiUrl = this.configService.get<string>('DIGIPAY_API_URL')!;

    try {
      const response = await fetch(`${apiUrl}/tickets/business/${ticket}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Agent: 'WEB',
          'Digipay-Version': '2022-02-02',
        },
      });

      const data = await response.json();

      // بررسی موفقیت (مطابق مستندات دیجی‌پی)
      const isSuccess = data.result?.status === 0 && data.status === 'success';

      if (!isSuccess) {
        // پرداخت ناموفق
        payment.status = PaymentStatus.FAILED;
        payment.resCode = data.result?.code || 'FAILED';
        await this.paymentRepo.save(payment);
        // لغو سفارش بدون تغییر موجودی
        await this.ordersService.failOrderPayment(payment.orderId);
        return {
          success: false,
          message: data.result?.message || 'پرداخت ناموفق بود',
        };
      }

      // ۴. پرداخت موفق
      payment.status = PaymentStatus.SUCCESS;
      payment.resCode = '0';
      payment.saleReferenceId = data.referenceId || null;
      await this.paymentRepo.save(payment);

      // ۵. تأیید نهایی سفارش (کاهش موجودی و خالی کردن سبد)
      await this.ordersService.confirmOrderPayment(payment.orderId);

      return {
        success: true,
        message: 'پرداخت با موفقیت انجام شد',
        orderId: payment.orderId,
      };
    } catch (error) {
      this.logger.error('خطا در استعلام وضعیت پرداخت دیجی‌پی', error.message);
      payment.status = PaymentStatus.FAILED;
      await this.paymentRepo.save(payment);
      await this.ordersService.failOrderPayment(payment.orderId);
      return {
        success: false,
        message: 'خطا در تأیید پرداخت',
      };
    }
  }
}
