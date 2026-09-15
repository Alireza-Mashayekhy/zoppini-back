// src/payment/services/digipay-payment.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { OrdersService } from 'src/order/order.service';
import { WalletChargeStatus } from 'src/wallet/entities/wallet-charge.entity';
import { Repository } from 'typeorm';

import {
  Payment,
  PaymentGateway,
  PaymentPurpose,
  PaymentStatus,
} from '../entities/payment.entity';
import { DigipayAuthService } from './digipay-auth.service';
import { PaymentGuardService } from './payment-guard.service';
import { WalletChargeService } from './wallet-charge.service';

@Injectable()
export class DigipayPaymentService {
  private readonly logger = new Logger(DigipayPaymentService.name);

  constructor(
    private configService: ConfigService,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
    private ordersService: OrdersService,
    private authService: DigipayAuthService,

    private readonly paymentGuard: PaymentGuardService,
    private readonly walletChargeService: WalletChargeService,
  ) {}

  private getOrderCardAmount(order: Order): number {
    const walletPayment = Number(order.walletPayment ?? 0);

    return Math.round((Number(order.finalPrice) - walletPayment) * 10);
  }

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

    const apiUrl = this.configService.get<string>('DIGIPAY_API_URL')!;

    const callbackUrl = this.configService.get<string>(
      'DIGIPAY_PAYMENT_CALLBACK_URL',
    )!;

    const providerId = `ORDER-${orderId}-${Date.now()}`;

    const amount = this.getOrderCardAmount(order);

    if (!amount || amount <= 0) {
      throw new BadRequestException('مبلغ سفارش نامعتبر است');
    }

    const payload = {
      cellNumber: order.user?.phone || '',
      amount,
      providerId,
      callbackUrl,
    };

    const url = `${apiUrl}/tickets/business?type=11`;

    this.logger.log('========== DIGIPAY REQUEST ==========');
    this.logger.log(`URL: ${url}`);
    this.logger.log(`Payload: ${JSON.stringify(payload, null, 2)}`);
    this.logger.log('=====================================');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Agent: 'WEB',
          'Digipay-Version': '2022-02-02',
          'Content-Type': 'application/json; charset=UTF-8',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();

      this.logger.log(`Digipay response status: ${response.status}`);

      this.logger.log(`Digipay response: ${responseText}`);

      let data: any;

      try {
        data = JSON.parse(responseText);
      } catch {
        throw new BadRequestException('پاسخ دیجی‌پی معتبر نیست');
      }

      if (!response.ok) {
        throw new BadRequestException(
          data?.result?.message ||
            data?.message ||
            `Digipay HTTP ${response.status}`,
        );
      }

      if (data?.result?.status !== 0) {
        throw new BadRequestException(
          data?.result?.message || 'خطا در ایجاد تیکت خرید',
        );
      }

      const ticket = data.ticket;
      const payUrl = data.redirectUrl;

      if (!ticket) {
        throw new BadRequestException('Ticket از دیجی‌پی دریافت نشد');
      }

      if (!payUrl) {
        throw new BadRequestException('Redirect URL از دیجی‌پی دریافت نشد');
      }

      const payment = this.paymentRepo.create({
        orderId,
        refId: ticket,
        amount,
        gateway: PaymentGateway.DIGIPAY,
        status: PaymentStatus.PENDING,
        resCode: '0',
        gatewayResponse: data,
      });

      await this.paymentRepo.save(payment);

      return {
        refId: ticket,
        payUrl,
      };
    } catch (error: any) {
      this.logger.error(
        '❌ خطا در درخواست پرداخت دیجی‌پی',
        error?.stack || error,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException('خطا در ارتباط با درگاه دیجی‌پی');
    }
  }

  async requestWalletCharge(
    chargeId: number,
    userId: number,
  ): Promise<{ refId: string; payUrl: string }> {
    const charge = await this.walletChargeService.getChargeWithUser(chargeId);

    if (!charge || charge.user.id !== userId) {
      throw new BadRequestException('درخواست شارژ یافت نشد');
    }

    if (charge.status === WalletChargeStatus.SUCCESS) {
      throw new BadRequestException('این درخواست شارژ قبلاً پرداخت شده است');
    }

    const amount = Math.round(Number(charge.amount) * 10);

    if (!amount || amount <= 0) {
      throw new BadRequestException('مبلغ شارژ نامعتبر است');
    }

    const accessToken = await this.authService.getAccessToken();

    const apiUrl = this.configService.get<string>('DIGIPAY_API_URL')!;

    const callbackUrl = this.configService.get<string>(
      'DIGIPAY_PAYMENT_CALLBACK_URL',
    )!;

    const providerId = `WALLET-${chargeId}-${Date.now()}`;

    const payload = {
      cellNumber: charge.user?.phone || '',
      amount,
      providerId,
      callbackUrl,
    };

    const url = `${apiUrl}/tickets/business?type=11`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Agent: 'WEB',
          'Digipay-Version': '2022-02-02',
          'Content-Type': 'application/json; charset=UTF-8',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();

      let data: any;

      try {
        data = JSON.parse(responseText);
      } catch {
        throw new BadRequestException('پاسخ دیجی‌پی معتبر نیست');
      }

      if (!response.ok) {
        throw new BadRequestException(
          data?.result?.message ||
            data?.message ||
            `Digipay HTTP ${response.status}`,
        );
      }

      if (data?.result?.status !== 0) {
        throw new BadRequestException(
          data?.result?.message || 'خطا در ایجاد تیکت خرید',
        );
      }

      const ticket = data.ticket;
      const payUrl = data.redirectUrl;

      if (!ticket) {
        throw new BadRequestException('Ticket از دیجی‌پی دریافت نشد');
      }

      if (!payUrl) {
        throw new BadRequestException('Redirect URL از دیجی‌پی دریافت نشد');
      }

      const payment = this.paymentRepo.create({
        orderId: null,
        walletChargeId: charge.id,
        purpose: PaymentPurpose.WALLET_CHARGE,
        refId: ticket,
        amount,
        gateway: PaymentGateway.DIGIPAY,
        status: PaymentStatus.PENDING,
        resCode: '0',
        gatewayResponse: data,
      });

      await this.paymentRepo.save(payment);

      return {
        refId: ticket,
        payUrl,
      };
    } catch (error: any) {
      this.logger.error(
        '❌ خطا در درخواست شارژ کیف پول از دیجی‌پی',
        error?.stack || error,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException('خطا در ارتباط با درگاه دیجی‌پی');
    }
  }

  async verifyPayment(ticket: string): Promise<{
    success: boolean;
    message: string;
    orderId?: number;
  }> {
    const payment = await this.paymentRepo.findOne({
      where: {
        refId: ticket,
        gateway: PaymentGateway.DIGIPAY,
      },
    });

    if (!payment) {
      throw new NotFoundException('تراکنش یافت نشد');
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      return {
        success: true,
        message: 'پرداخت قبلاً تأیید شده است',
        orderId: payment.orderId ?? undefined,
      };
    }

    const accessToken = await this.authService.getAccessToken();

    const apiUrl = this.configService.get<string>('DIGIPAY_API_URL')!;

    const url = `${apiUrl}/tickets/business/${ticket}`;

    this.logger.log('========== DIGIPAY VERIFY ==========');
    this.logger.log(`URL: ${url}`);
    this.logger.log(`Ticket: ${ticket}`);
    this.logger.log(`Token exists: ${Boolean(accessToken)}`);
    this.logger.log('====================================');

    try {
      const response = await fetch(url, {
        method: 'GET',

        headers: {
          Authorization: `Bearer ${accessToken}`,
          Agent: 'WEB',
          'Digipay-Version': '2022-02-02',
        },
      });

      const responseText = await response.text();

      this.logger.log('========== DIGIPAY VERIFY RESPONSE ==========');
      this.logger.log(`HTTP Status: ${response.status}`);
      this.logger.log(`Response Body: ${responseText}`);
      this.logger.log('==============================================');

      let data: any;

      try {
        data = JSON.parse(responseText);
      } catch {
        throw new BadRequestException('پاسخ نامعتبر از دیجی‌پی');
      }

      if (!response.ok) {
        throw new BadRequestException(
          data?.result?.message ||
            data?.message ||
            `Digipay HTTP ${response.status}`,
        );
      }

      const isSuccess = data.result?.status === 0 && data.status === 'success';

      if (!isSuccess) {
        payment.status = PaymentStatus.FAILED;
        payment.resCode = data.result?.code || 'FAILED';

        await this.paymentRepo.save(payment);

        if (payment.purpose === PaymentPurpose.ORDER) {
          await this.ordersService.failOrderPayment(payment.orderId!);
        } else {
          await this.walletChargeService.markChargeFailed(payment);
        }

        return {
          success: false,
          message: data.result?.message || 'پرداخت ناموفق بود',
          orderId: payment.orderId ?? undefined,
        };
      }

      payment.status = PaymentStatus.SUCCESS;
      payment.resCode = '0';

      if (data.referenceId != null) {
        payment.saleReferenceId = String(data.referenceId);
      }

      await this.paymentRepo.save(payment);

      if (payment.purpose === PaymentPurpose.WALLET_CHARGE) {
        /*
         * شارژ کیف پول: وجه گرفته شده؛ حالا به کیف پول واریز می‌شود
         * (واریز idempotent است — کلید wallet-charge-{chargeId}).
         */
        try {
          await this.walletChargeService.settleCharge(payment);
        } catch (error) {
          this.logger.error(
            `❌ پرداخت ${payment.id} موفق بود ولی واریز به کیف پول (شارژ ${payment.walletChargeId}) خطا خورد! ` +
              'پرداخت SUCCESS باقی می‌ماند تا بررسی شود.',
            error instanceof Error ? error.stack : String(error),
          );
        }
      } else {
        /*
         * نهایی‌کردن سفارش (کاهش موجودی + خالی کردن سبد)
         * اگر خطا بدهد، پول گرفته شده؛ پس پرداخت را SUCCESS نگه می‌داریم
         * و سفارش را لغو نمی‌کنیم تا دستی بررسی/اصلاح شود.
         */
        try {
          const order = await this.ordersService.findOneForAdmin(
            payment.orderId!,
          );

          if (order.status === OrderStatus.PENDING) {
            await this.ordersService.confirmOrderPayment(payment.orderId!);
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
            orderId: payment.orderId ?? undefined,
          };
        }
      }

      return {
        success: true,
        message: 'پرداخت با موفقیت انجام شد',
        orderId: payment.orderId ?? undefined,
      };
    } catch (error) {
      /*
       * خطای شبکه/نامشخص: وضعیت واقعی تراکنش معلوم نیست.
       * پرداخت را FAILED نمی‌کنیم و سفارش را لغو نمی‌کنیم
       * تا بررسی مجدد یا دستی ممکن باشد.
       * (خطای قطعی درگاه با return در بدنه try مدیریت شده است)
       */
      this.logger.error(
        `❌ خطا در استعلام وضعیت پرداخت دیجی‌پی برای پرداخت ${payment.id} (order ${payment.orderId}). ` +
          'وضعیت روی PENDING می‌ماند.',
        error instanceof Error ? error.stack : String(error),
      );

      return {
        success: false,
        message: 'خطا در تأیید پرداخت؛ تراکنش در حال بررسی است',
        orderId: payment.orderId ?? undefined,
      };
    }
  }

  async findPaymentByRefId(refId: string) {
    return this.paymentRepo.findOne({
      where: {
        refId,
        gateway: PaymentGateway.DIGIPAY,
      },
    });
  }

  async failPayment(payment: Payment) {
    payment.status = PaymentStatus.FAILED;

    return this.paymentRepo.save(payment);
  }
}
