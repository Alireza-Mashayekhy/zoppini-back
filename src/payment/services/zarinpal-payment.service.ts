import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { OrdersService } from 'src/order/order.service';
import { Repository } from 'typeorm';

import {
  Payment,
  PaymentGateway,
  PaymentStatus,
} from '../entities/payment.entity';

@Injectable()
export class ZarinpalPaymentService {
  private readonly logger = new Logger(ZarinpalPaymentService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,

    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,

    private readonly ordersService: OrdersService,
  ) {}

  private getMerchantId(): string {
    const merchantId = this.configService.get<string>('ZARINPAL_MERCHANT_ID');

    if (!merchantId) {
      throw new Error('ZARINPAL_MERCHANT_ID تنظیم نشده است');
    }

    return merchantId;
  }

  private getRequestUrl(): string {
    return (
      this.configService.get<string>('ZARINPAL_REQUEST_URL') ??
      'https://payment.zarinpal.com/pg/v4/payment/request.json'
    );
  }

  private getVerifyUrl(): string {
    return (
      this.configService.get<string>('ZARINPAL_VERIFY_URL') ??
      'https://payment.zarinpal.com/pg/v4/payment/verify.json'
    );
  }

  private getStartPayUrl(authority: string): string {
    return `https://payment.zarinpal.com/pg/StartPay/${authority}`;
  }

  /**
   * ایجاد درخواست پرداخت
   */
  async requestPayment(
    orderId: number,
    userId: number,
  ): Promise<{
    refId: string;
    payUrl: string;
  }> {
    const order = await this.ordersService.findOneForPayment(orderId, userId);

    if (!order) {
      throw new BadRequestException('سفارش یافت نشد');
    }

    const existingPayment = await this.paymentRepo.findOne({
      where: {
        orderId,
        gateway: PaymentGateway.ZARINPAL,
      },
      order: {
        id: 'DESC',
      },
    });

    if (existingPayment && existingPayment.status === PaymentStatus.PENDING) {
      throw new BadRequestException('درخواست پرداخت قبلاً ثبت شده است');
    }

    /*
     * طبق مستندات زرین پال:
     *
     * amount باید به ریال ارسال شود.
     *
     * اگر finalPrice شما در دیتابیس تومان است:
     * تومان × 10 = ریال
     */
    const amount = Math.round(Number(order.finalPrice) * 10);

    if (!amount || amount <= 0) {
      throw new BadRequestException('مبلغ سفارش نامعتبر است');
    }

    const callbackUrl = this.configService.get<string>(
      'ZARINPAL_PAYMENT_CALLBACK_URL',
    );

    if (!callbackUrl) {
      throw new BadRequestException('آدرس callback زرین پال تنظیم نشده است');
    }

    const payload = {
      merchant_id: this.getMerchantId(),
      amount,
      currency: 'IRR',
      description: `پرداخت سفارش شماره ${order.orderNumber}`,
      callback_url: callbackUrl,
      metadata: {
        mobile: order.user?.phone || '',
        email: order.user?.email || '',
        order_id: String(orderId),
      },
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(this.getRequestUrl(), payload, {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        }),
      );

      const data = response.data;

      /*
       * ساختار مستندات:
       *
       * {
       *   data: {
       *     code: 100,
       *     message: "Success",
       *     authority: "..."
       *   },
       *   errors: []
       * }
       */

      const error = data?.errors?.[0];

      if (error) {
        this.logger.error(
          `Zarinpal request error ${error.code}: ${error.message}`,
        );

        throw new BadRequestException(error.message);
      }

      if (data?.data?.code !== 100) {
        throw new BadRequestException(
          data?.data?.message ||
            `خطا در ایجاد تراکنش زرین پال (${data?.data?.code})`,
        );
      }

      const authority = data.data.authority;

      if (!authority) {
        throw new BadRequestException('Authority از زرین پال دریافت نشد');
      }

      const payment = this.paymentRepo.create({
        orderId,
        refId: authority,
        amount,
        gateway: PaymentGateway.ZARINPAL,
        status: PaymentStatus.PENDING,
        resCode: String(data.data.code),
        gatewayResponse: data,
      });

      await this.paymentRepo.save(payment);

      return {
        refId: authority,
        payUrl: this.getStartPayUrl(authority),
      };
    } catch (error) {
      if (error.isAxiosError) {
        this.logger.error('Zarinpal status:', error.response?.status);

        this.logger.error(
          'Zarinpal response:',
          JSON.stringify(error.response?.data, null, 2),
        );

        this.logger.error(
          'Zarinpal request:',
          JSON.stringify(error.config?.data, null, 2),
        );
      } else {
        this.logger.error(error?.stack || error);
      }

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        error.response?.data?.errors?.[0]?.message ||
          error.response?.data?.message ||
          'خطا در ارتباط با درگاه زرین پال',
      );
    }
  }

  /**
   * تایید تراکنش
   */
  async verifyPayment(authority: string): Promise<{
    success: boolean;
    message: string;
    orderId?: number;
  }> {
    const payment = await this.paymentRepo.findOne({
      where: {
        refId: authority,
        gateway: PaymentGateway.ZARINPAL,
      },
    });

    if (!payment) {
      throw new BadRequestException('تراکنش یافت نشد');
    }

    /*
     * اگر قبلاً موفق شده، دوباره موجودی کم نکن.
     */
    if (payment.status === PaymentStatus.SUCCESS) {
      return {
        success: true,
        message: 'پرداخت قبلاً تأیید شده است',
        orderId: payment.orderId,
      };
    }

    const payload = {
      merchant_id: this.getMerchantId(),
      amount: Number(payment.amount),
      authority,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(this.getVerifyUrl(), payload, {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        }),
      );

      const data = response.data;

      const error = data?.errors?.[0];

      if (error) {
        payment.status = PaymentStatus.FAILED;
        payment.resCode = String(error.code);
        payment.gatewayResponse = data;

        await this.paymentRepo.save(payment);

        await this.ordersService.failOrderPayment(payment.orderId);

        return {
          success: false,
          message: error.message,
          orderId: payment.orderId,
        };
      }

      const code = Number(data?.data?.code);

      /*
       * code = 100
       * پرداخت موفق و برای اولین بار verify شده.
       *
       * code = 101
       * این تراکنش قبلاً verify شده و موفق بوده.
       */
      if (code !== 100 && code !== 101) {
        payment.status = PaymentStatus.FAILED;
        payment.resCode = String(code);
        payment.gatewayResponse = data;

        await this.paymentRepo.save(payment);

        await this.ordersService.failOrderPayment(payment.orderId);

        return {
          success: false,
          message: data?.data?.message || `پرداخت ناموفق: کد ${code}`,
          orderId: payment.orderId,
        };
      }

      // پرداخت موفق
      payment.status = PaymentStatus.SUCCESS;
      payment.resCode = String(code);

      const refId = Number(data?.data?.ref_id);

      if (Number.isFinite(refId)) {
        payment.saleReferenceId = refId;
      }

      payment.gatewayResponse = data;

      await this.paymentRepo.save(payment);

      /*
       * فقط در بار اول موجودی و سفارش را نهایی کن.
       *
       * چون 101 یعنی قبلاً verify شده.
       */
      if (code === 100) {
        await this.ordersService.confirmOrderPayment(payment.orderId);
      }

      return {
        success: true,
        message:
          code === 101
            ? 'پرداخت قبلاً تأیید شده است'
            : 'پرداخت با موفقیت انجام شد',
        orderId: payment.orderId,
      };
    } catch (error) {
      this.logger.error('خطا در verify زرین پال', error?.stack || error);

      /*
       * اینجا با احتیاط وضعیت payment را failed می‌کنیم.
       */
      payment.status = PaymentStatus.FAILED;
      payment.resCode = 'VERIFY_ERROR';

      await this.paymentRepo.save(payment);

      await this.ordersService.failOrderPayment(payment.orderId);

      return {
        success: false,
        message: 'خطا در تأیید پرداخت',
        orderId: payment.orderId,
      };
    }
  }

  async findPaymentByRefId(refId: string) {
    return this.paymentRepo.findOne({
      where: {
        refId,
        gateway: PaymentGateway.ZARINPAL,
      },
    });
  }

  async failPayment(payment: Payment, resCode: string) {
    payment.status = PaymentStatus.FAILED;
    payment.resCode = resCode;

    return this.paymentRepo.save(payment);
  }
}
