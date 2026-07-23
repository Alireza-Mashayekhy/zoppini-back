import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { GraphQLClient } from 'graphql-request';
import { OrdersService } from 'src/order/order.service';
import { Repository } from 'typeorm';

import {
  Payment,
  PaymentGateway,
  PaymentStatus,
} from '../entities/payment.entity';
import { ZarinpalAuthService } from './zarinpal-auth.service';

@Injectable()
export class ZarinpalPaymentService {
  private readonly logger = new Logger(ZarinpalPaymentService.name);
  private graphqlClient: GraphQLClient | null = null;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
    private ordersService: OrdersService,
    private authService: ZarinpalAuthService,
  ) {}

  private async getGraphQLClient(): Promise<GraphQLClient> {
    if (this.graphqlClient) return this.graphqlClient;

    const accessToken = await this.authService.getAccessToken();
    const apiUrl = this.configService.get<string>('ZARINPAL_API_URL')!;

    this.graphqlClient = new GraphQLClient(apiUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    return this.graphqlClient;
  }

  async requestPayment(
    orderId: number,
  ): Promise<{ refId: string; payUrl: string }> {
    const order = await this.ordersService.findOneForAdmin(orderId);
    if (!order) {
      throw new BadRequestException('سفارش یافت نشد');
    }

    const existingPayment = await this.paymentRepo.findOne({
      where: { orderId, gateway: PaymentGateway.ZARINPAL },
    });
    if (existingPayment && existingPayment.status === PaymentStatus.PENDING) {
      throw new BadRequestException('درخواست پرداخت قبلاً ثبت شده است');
    }

    const callbackUrl = this.configService.get<string>(
      'ZARINPAL_PAYMENT_CALLBACK_URL',
    )!;
    const amount = Math.round(order.finalPrice * 10); // تبدیل به ریال

    const mutation = `
      mutation CreatePayment($input: PaymentInput!) {
        createPayment(input: $input) {
          authority
          payment_url
          errors {
            code
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        amount: amount,
        description: `پرداخت سفارش شماره ${order.orderNumber}`,
        email: order.user?.email || '',
        mobile: order.user?.phone || '',
        callback_url: callbackUrl,
        metadata: {
          order_id: String(orderId),
          order_number: order.orderNumber,
        },
      },
    };

    try {
      const client = await this.getGraphQLClient();
      const result = await client.request(mutation, variables);

      const response = result.createPayment;
      if (response.errors && response.errors.length > 0) {
        throw new BadRequestException(response.errors[0].message);
      }

      const authority = response.authority;
      const paymentUrl = response.payment_url;

      const payment = this.paymentRepo.create({
        orderId,
        refId: authority,
        amount,
        gateway: PaymentGateway.ZARINPAL,
        status: PaymentStatus.PENDING,
        resCode: '0',
        gatewayResponse: response,
      });
      await this.paymentRepo.save(payment);

      return { refId: authority, payUrl: paymentUrl };
    } catch (error) {
      this.logger.error(error.message, error.stack);
      throw new BadRequestException('خطا در ارتباط با درگاه زرین‌پال');
    }
  }

  async verifyPayment(
    authority: string,
  ): Promise<{ success: boolean; message: string; orderId?: number }> {
    const payment = await this.paymentRepo.findOne({
      where: { refId: authority, gateway: PaymentGateway.ZARINPAL },
    });
    if (!payment) {
      throw new BadRequestException('تراکنش یافت نشد');
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      return {
        success: true,
        message: 'پرداخت قبلاً تأیید شده است',
        orderId: payment.orderId,
      };
    }

    const mutation = `
      mutation VerifyPayment($authority: String!) {
        verifyPayment(authority: $authority) {
          success
          code
          ref_id
          errors {
            code
            message
          }
        }
      }
    `;

    try {
      const client = await this.getGraphQLClient();
      const result = await client.request(mutation, { authority });

      const response = result.verifyPayment;

      if (response.errors && response.errors.length > 0) {
        payment.status = PaymentStatus.FAILED;
        payment.resCode = response.errors[0].code;
        await this.paymentRepo.save(payment);
        // لغو سفارش (بدون تغییر موجودی)
        await this.ordersService.failOrderPayment(payment.orderId);
        return { success: false, message: response.errors[0].message };
      }

      if (!response.success) {
        payment.status = PaymentStatus.FAILED;
        payment.resCode = response.code;
        await this.paymentRepo.save(payment);
        await this.ordersService.failOrderPayment(payment.orderId);
        return {
          success: false,
          message: `پرداخت ناموفق: کد ${response.code}`,
        };
      }

      // پرداخت موفق
      payment.status = PaymentStatus.SUCCESS;
      payment.resCode = '0';
      payment.saleReferenceId = response.ref_id;
      await this.paymentRepo.save(payment);

      // =============== تغییر اصلی اینجاست ===============
      // به‌جای updateStatus، از confirmOrderPayment استفاده می‌کنیم
      // این متد موجودی را کم کرده و سبد خرید را خالی می‌کند
      await this.ordersService.confirmOrderPayment(payment.orderId);
      // ====================================================

      return {
        success: true,
        message: 'پرداخت با موفقیت انجام شد',
        orderId: payment.orderId,
      };
    } catch (error) {
      this.logger.error(error.message, error.stack);
      payment.status = PaymentStatus.FAILED;
      await this.paymentRepo.save(payment);
      await this.ordersService.failOrderPayment(payment.orderId);
      return { success: false, message: 'خطا در تأیید پرداخت' };
    }
  }
}
