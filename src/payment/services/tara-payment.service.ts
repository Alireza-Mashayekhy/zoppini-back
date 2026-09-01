import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderStatus } from 'src/order/entities/order.entity';
import { OrdersService } from 'src/order/order.service';
import { Repository } from 'typeorm';

import {
  Payment,
  PaymentGateway,
  PaymentStatus,
} from '../entities/payment.entity';
import { PaymentGuardService } from './payment-guard.service';
import { TaraAuthService } from './tara-auth.service';

@Injectable()
export class TaraPaymentService {
  private readonly logger = new Logger(TaraPaymentService.name);

  constructor(
    private configService: ConfigService,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
    private ordersService: OrdersService,
    private authService: TaraAuthService,

    private readonly paymentGuard: PaymentGuardService,
  ) {}

  async requestPayment(
    orderId: number,
    userId: number,
  ): Promise<{ refId: string; payUrl: string }> {
    const order = await this.ordersService.findOneForPayment(orderId, userId);
    if (!order) {
      throw new BadRequestException('سفارش یافت نشد');
    }

    // سفارش باید PENDING باشد و درخواست پرداخت بازی (هر درگاهی) نباشد
    await this.paymentGuard.ensureOrderPayable(order);

    const accessToken = await this.authService.getAccessToken();
    const apiUrl = this.configService.get<string>('TARA_API_URL')!;
    const callbackUrl = this.configService.get<string>(
      'TARA_PAYMENT_CALLBACK_URL',
    )!;
    const amount = Math.round(order.finalPrice * 10); // تبدیل به ریال

    // ساخت آیتم‌های صورت‌حساب (برای تارا)
    const invoiceItems = order.items.map(item => ({
      name: item.variant.product?.title || 'محصول',
      code: item.variant.product?.productCode || '',
      count: item.quantity,
      unit: 1,
      fee: Math.round(item.variant.price * 10), // قیمت هر واحد به ریال
      group: '',
      groupTitle: '',
      data: '',
    }));

    const payload = {
      ip: '127.0.0.1', // آدرس IP کاربر (می‌توانید از req دریافت کنید)
      serviceAmountList: [
        {
          serviceId: 1, // شناسه سرویس (مقدار پیش‌فرض)
          amount: amount,
        },
      ],
      taraInvoiceItemList: invoiceItems,
      additionalData: '',
      callBackUrl: callbackUrl,
      amount: String(amount),
      mobile: order.user?.phone || '',
      orderId: String(orderId),
      vat: 0,
    };

    try {
      const response = await fetch(`${apiUrl}/api/getToken`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (data.result !== '0') {
        throw new BadRequestException(
          data.description || 'خطا در دریافت توکن تارا',
        );
      }

      const token = data.token;

      // ذخیره پرداخت
      const payment = this.paymentRepo.create({
        orderId,
        refId: token,
        amount,
        gateway: PaymentGateway.TARA,
        status: PaymentStatus.PENDING,
        resCode: data.result,
        gatewayResponse: data,
      });
      await this.paymentRepo.save(payment);

      // آدرس هدایت کاربر به صفحه پرداخت
      const payUrl = `${apiUrl}/api/ipgPurchase`;
      // برای هدایت کاربر، باید یک فرم POST به payUrl با پارامترهای username و token ارسال کنیم
      // این کار را در فرانت‌اند انجام می‌دهیم

      return { refId: token, payUrl };
    } catch (error) {
      this.logger.error(error.message, error.stack);
      throw new BadRequestException('خطا در ارتباط با درگاه تارا');
    }
  }

  async verifyPayment(
    token: string,
  ): Promise<{ success: boolean; message: string; orderId?: number }> {
    const payment = await this.paymentRepo.findOne({
      where: { refId: token, gateway: PaymentGateway.TARA },
    });
    if (!payment) {
      throw new NotFoundException('تراکنش یافت نشد');
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      return {
        success: true,
        message: 'پرداخت قبلاً تأیید شده است',
        orderId: payment.orderId,
      };
    }

    const accessToken = await this.authService.getAccessToken();
    const apiUrl = this.configService.get<string>('TARA_API_URL')!;

    try {
      // ۱. فراخوانی سرویس Verify
      const verifyPayload = {
        ip: '127.0.0.1',
        token: token,
      };

      const response = await fetch(`${apiUrl}/api/purchaseVerify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(verifyPayload),
      });

      const data = await response.json();

      if (data.result !== '0') {
        // خطا در تأیید
        payment.status = PaymentStatus.FAILED;
        payment.resCode = data.result;
        await this.paymentRepo.save(payment);
        await this.ordersService.failOrderPayment(payment.orderId);
        return {
          success: false,
          message: data.description || 'خطا در تأیید پرداخت',
        };
      }

      // ۲. پرداخت موفق
      payment.status = PaymentStatus.SUCCESS;
      payment.resCode = '0';
      payment.saleReferenceId = data.rrn || null;
      await this.paymentRepo.save(payment);

      /*
       * ۳. تأیید نهایی سفارش (کاهش موجودی و خالی کردن سبد)
       * اگر خطا بدهد، پول گرفته شده؛ پس پرداخت را SUCCESS نگه می‌داریم
       * و سفارش را لغو نمی‌کنیم تا دستی بررسی/اصلاح شود.
       */
      try {
        const order = await this.ordersService.findOneForAdmin(payment.orderId);

        if (order.status === OrderStatus.PENDING) {
          await this.ordersService.confirmOrderPayment(payment.orderId);
        }
      } catch (error) {
        this.logger.error(
          `❌ پرداخت ${payment.id} موفق بود ولی ثبت نهایی سفارش ${payment.orderId} خطا خورد! ` +
            'پرداخت SUCCESS و سفارش PENDING باقی می‌ماند تا بررسی شود.',
          error instanceof Error ? error.stack : String(error),
        );

        return {
          success: true,
          message: 'پرداخت دریافت شد؛ ثبت نهایی سفارش به‌زودی انجام می‌شود',
          orderId: payment.orderId,
        };
      }

      return {
        success: true,
        message: 'پرداخت با موفقیت انجام شد',
        orderId: payment.orderId,
      };
    } catch (error) {
      /*
       * خطای شبکه/نامشخص: وضعیت واقعی تراکنش معلوم نیست.
       * پرداخت را FAILED نمی‌کنیم و سفارش را لغو نمی‌کنیم
       * تا بررسی مجدد یا دستی ممکن باشد.
       */
      this.logger.error(
        `❌ خطا در تأیید پرداخت تارا برای پرداخت ${payment.id} (order ${payment.orderId}). ` +
          'وضعیت روی PENDING می‌ماند.',
        error instanceof Error ? error.stack : String(error),
      );

      return {
        success: false,
        message: 'خطا در تأیید پرداخت؛ تراکنش در حال بررسی است',
        orderId: payment.orderId,
      };
    }
  }

  // سرویس استعلام (در صورت نیاز)
  async inquiryPayment(token: string): Promise<any> {
    const accessToken = await this.authService.getAccessToken();
    const apiUrl = this.configService.get<string>('TARA_API_URL')!;

    try {
      const response = await fetch(`${apiUrl}/api/purchaseInquiry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ ip: '127.0.0.1', token }),
      });

      return response.json();
    } catch (error) {
      this.logger.error('خطا در استعلام پرداخت تارا', error.message);
      throw new BadRequestException('خطا در استعلام پرداخت');
    }
  }

  async findPaymentByRefId(refId: string) {
    return this.paymentRepo.findOne({
      where: {
        refId,
        gateway: PaymentGateway.TARA,
      },
    });
  }

  async failPayment(payment: Payment, resCode: string) {
    payment.status = PaymentStatus.FAILED;
    payment.resCode = resCode;

    return this.paymentRepo.save(payment);
  }
}
