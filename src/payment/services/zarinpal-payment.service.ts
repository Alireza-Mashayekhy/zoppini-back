import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { OrdersService } from 'src/order/order.service';
import { WalletChargeStatus } from 'src/wallet/entities/wallet-charge.entity';
import { LessThan, Repository } from 'typeorm';

import {
  Payment,
  PaymentGateway,
  PaymentPurpose,
  PaymentStatus,
} from '../entities/payment.entity';
import { PaymentGuardService } from './payment-guard.service';
import { WalletChargeService } from './wallet-charge.service';

@Injectable()
export class ZarinpalPaymentService {
  private readonly logger = new Logger(ZarinpalPaymentService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,

    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,

    private readonly ordersService: OrdersService,

    private readonly paymentGuard: PaymentGuardService,

    private readonly walletChargeService: WalletChargeService,
  ) {}

  private getOrderCardAmount(order: Order): number {
    const walletPayment = Number(order.walletPayment ?? 0);

    return Math.round((Number(order.finalPrice) - walletPayment) * 10);
  }

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

    // سفارش باید PENDING باشد و درخواست پرداخت بازی (هر درگاهی) نباشد
    await this.paymentGuard.ensureOrderPayable(order);

    /*
     * طبق مستندات زرین پال:
     *
     * amount باید به ریال ارسال شود.
     *
     * اگر finalPrice شما در دیتابیس تومان است:
     * تومان × 10 = ریال
     */
    const amount = this.getOrderCardAmount(order);

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
    } catch (error: any) {
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
      description: 'شارژ کیف پول',
      callback_url: callbackUrl,
      metadata: {
        mobile: charge.user?.phone || '',
        email: charge.user?.email || '',
        order_id: String(chargeId),
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

      const error = data?.errors?.[0];

      if (error) {
        this.logger.error(
          `Zarinpal request (wallet charge) error ${error.code}: ${error.message}`,
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
        orderId: null,
        walletChargeId: charge.id,
        purpose: PaymentPurpose.WALLET_CHARGE,
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
    } catch (error: any) {
      this.logger.error(
        '❌ خطا در درخواست شارژ کیف پول از زرین‌پال',
        error?.stack || error,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException('خطا در ارتباط با درگاه زرین پال');
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
      this.logger.warn(
        `verify زرین‌پال: تراکنشی با authority=${authority} یافت نشد.`,
      );
      throw new BadRequestException('تراکنش یافت نشد');
    }

    this.logger.log(
      `🔍 شروع verify زرین‌پال برای پرداخت ${payment.id} (سفارش ${payment.orderId}, ` +
        `purpose=${payment.purpose}, status فعلی=${payment.status}, amount=${payment.amount})`,
    );

    /*
     * اگر قبلاً موفق شده، دوباره موجودی کم نکن.
     */
    if (payment.status === PaymentStatus.SUCCESS) {
      this.logger.log(
        `↩️ پرداخت ${payment.id} قبلاً SUCCESS شده؛ verify مجدد نادیده گرفته شد.`,
      );
      return {
        success: true,
        message: 'پرداخت قبلاً تأیید شده است',
        orderId: payment.orderId ?? undefined,
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

      this.logger.log(
        `📥 پاسخ verify زرین‌پال برای پرداخت ${payment.id}: ` +
          JSON.stringify({
            code: data?.data?.code,
            ref_id: data?.data?.ref_id,
            card_pan: data?.data?.card_pan,
            message: data?.data?.message,
            errors: data?.errors,
          }),
      );

      if (error) {
        payment.status = PaymentStatus.FAILED;
        payment.resCode = String(error.code);
        payment.gatewayResponse = data;

        await this.paymentRepo.save(payment);

        if (payment.purpose === PaymentPurpose.ORDER) {
          await this.ordersService.failOrderPayment(payment.orderId!);
        } else {
          await this.walletChargeService.markChargeFailed(payment);
        }

        return {
          success: false,
          message: error.message,
          orderId: payment.orderId ?? undefined,
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
        this.logger.warn(
          `⚠️ پاسخ verify غیرموفق از زرین‌پال برای پرداخت ${payment.id}: code=${code}, ` +
            `message=${data?.data?.message || '(خالی)'}`,
        );
        payment.status = PaymentStatus.FAILED;
        payment.resCode = String(code);
        payment.gatewayResponse = data;

        await this.paymentRepo.save(payment);

        if (payment.purpose === PaymentPurpose.ORDER) {
          await this.ordersService.failOrderPayment(payment.orderId!);
        } else {
          await this.walletChargeService.markChargeFailed(payment);
        }

        return {
          success: false,
          message: data?.data?.message || `پرداخت ناموفق: کد ${code}`,
          orderId: payment.orderId ?? undefined,
        };
      }

      // پرداخت موفق
      this.logger.log(
        `✅ verify زرین‌پال موفق برای پرداخت ${payment.id}: code=${code}, ref_id=${data?.data?.ref_id}`,
      );
      payment.status = PaymentStatus.SUCCESS;
      payment.resCode = String(code);

      const refId = Number(data?.data?.ref_id);

      if (Number.isFinite(refId)) {
        payment.saleReferenceId = String(refId);
      }

      payment.gatewayResponse = data;

      await this.paymentRepo.save(payment);

      if (payment.purpose === PaymentPurpose.WALLET_CHARGE) {
        /*
         * شارژ کیف پول: وجه از کاربر گرفته شده؛ حالا به کیف پول واریز می‌شود.
         * واریز idempotent است (کلید wallet-charge-{chargeId}).
         */
        try {
          await this.walletChargeService.settleCharge(payment);
        } catch (error) {
          /*
           * پول گرفته شده است؛ پرداخت را SUCCESS نگه می‌داریم تا دستی
           * بررسی/واریز شود (واریز تکراری با همان کلید امن است).
           */
          this.logger.error(
            `❌ پرداخت ${payment.id} موفق بود ولی واریز به کیف پول (شارژ ${payment.walletChargeId}) خطا خورد! ` +
              'پرداخت SUCCESS باقی می‌ماند تا بررسی شود.',
            error instanceof Error ? error.stack : String(error),
          );
        }
      } else {
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
        message:
          code === 101
            ? 'پرداخت قبلاً تأیید شده است'
            : 'پرداخت با موفقیت انجام شد',
        orderId: payment.orderId ?? undefined,
      };
    } catch (error) {
      /*
       * خطای شبکه/نامشخص: وضعیت واقعی تراکنش معلوم نیست.
       * پرداخت را FAILED نمی‌کنیم و سفارش را لغو نمی‌کنیم
       * تا verify مجدد یا بررسی دستی ممکن باشد.
       * (کدهای قطعی خطای درگاه در بدنه try با return مدیریت شده‌اند)
       */
      this.logger.error(
        `❌ خطا در ارتباط با زرین پال برای پرداخت ${payment.id} (order ${payment.orderId}). ` +
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
        gateway: PaymentGateway.ZARINPAL,
      },
    });
  }

  async failPayment(payment: Payment, resCode: string) {
    payment.status = PaymentStatus.FAILED;
    payment.resCode = resCode;

    return this.paymentRepo.save(payment);
  }

  async reconcilePendingPayments(limit = 25): Promise<void> {
    const cutoff = new Date(Date.now() - 15 * 60_000);

    const pendingPayments = await this.paymentRepo.find({
      where: {
        gateway: PaymentGateway.ZARINPAL,
        status: PaymentStatus.PENDING,
        createdAt: LessThan(cutoff),
      },
      take: limit,
      order: { id: 'ASC' },
    });

    for (const payment of pendingPayments) {
      try {
        this.logger.log(
          `🔄 همسان‌سازی پرداخت بلاتکلیف زرین‌پال ${payment.id} (سفارش ${payment.orderId})`,
        );

        await this.verifyPayment(payment.refId);
      } catch (error) {
        this.logger.error(
          `❌ همسان‌سازی پرداخت زرین‌پال ${payment.id} خطا خورد:`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}
