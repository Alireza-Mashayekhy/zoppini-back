import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as soap from 'soap';
import { OrdersService } from 'src/order/order.service';
import { Repository } from 'typeorm';

import {
  Payment,
  PaymentGateway,
  PaymentStatus,
} from '../entities/payment.entity';
import { PaymentGuardService } from './payment-guard.service';

@Injectable()
export class MellatPaymentService {
  private readonly logger = new Logger(MellatPaymentService.name);
  private wsClient: any;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
    private ordersService: OrdersService,

    private readonly paymentGuard: PaymentGuardService,
  ) {}

  // === اصلاح متد getClient ===
  async getClient() {
    if (this.wsClient) return this.wsClient;
    const wsdlUrl = this.configService.get<string>('MELLAT_WS_URL');
    if (!wsdlUrl) {
      throw new Error('MELLAT_WS_URL is not defined in environment');
    }
    this.wsClient = await soap.createClientAsync(wsdlUrl);
    return this.wsClient;
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

    const terminalId = this.configService.get<string>('MELLAT_TERMINAL_ID')!;
    const userName = this.configService.get<string>('MELLAT_USERNAME')!;
    const userPassword = this.configService.get<string>('MELLAT_PASSWORD')!;

    // مسیر واقعی callback — سرور prefix سراسری «api» دارد
    const appUrl = this.configService.get<string>('APP_URL');
    const callbackUrl = `${appUrl}/api/payment/callback/mellat`;
    const payUrl = this.configService.get<string>('MELLAT_PAY_URL')!;

    const amount = Math.round(order.finalPrice * 10); // تبدیل تومان به ریال

    /*
     * طبق پروتکل ملت، orderId ارسالی در bpPayRequest باید در
     * bpVerifyRequest و bpSettleRequest عیناً تکرار شود؛
     * پس آن را تولید و در رکورد پرداخت ذخیره می‌کنیم (ستون saleOrderId).
     * (به‌ازای هر تلاش پرداخت یک مقدار یکتا لازم است)
     */
    const gatewayOrderId = Date.now() * 1000 + Math.floor(Math.random() * 1000);

    // تاریخ/ساعت باید به وقت تهران باشد نه وقت سرور
    const now = new Date();
    const localDate = now
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' })
      .replace(/-/g, '');
    const localTime = now
      .toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Tehran',
        hour12: false,
      })
      .replace(/:/g, '');

    const payload = {
      terminalId: Number(terminalId),
      userName,
      userPassword,
      orderId: gatewayOrderId,
      amount,
      localDate,
      localTime,
      additionalData: '',
      callBackUrl: callbackUrl,
      payerId: 0,
    };

    try {
      const client = await this.getClient();
      const result = await client.bpPayRequestAsync(payload);
      const response = result[0];
      const resCode = response.return;
      const parts = resCode.split(',');
      const code = parts[0];
      const refId = parts[1];

      if (code !== '0') {
        throw new BadRequestException(`خطا در درخواست پرداخت: کد ${code}`);
      }

      const payment = this.paymentRepo.create({
        orderId,
        refId,
        amount,
        gateway: PaymentGateway.MELLAT,
        status: PaymentStatus.PENDING,
        resCode: code,
        saleOrderId: gatewayOrderId, // لازم برای verify/settle
        gatewayResponse: response,
      });
      await this.paymentRepo.save(payment);

      return { refId, payUrl };
    } catch (error) {
      this.logger.error(error.message, error.stack);
      throw new BadRequestException('خطا در ارتباط با درگاه پرداخت');
    }
  }

  // src/payment/mellat-payment.service.ts (بخش verifyPayment)

  async verifyPayment(
    refId: string,
    callbackData?: {
      saleOrderId?: number | string;
      saleReferenceId?: number | string;
    },
  ): Promise<{ success: boolean; message: string; orderId?: number }> {
    const payment = await this.paymentRepo.findOne({
      where: { refId, gateway: PaymentGateway.MELLAT },
    });
    if (!payment) throw new BadRequestException('تراکنش یافت نشد');

    if (payment.status === PaymentStatus.SUCCESS) {
      return {
        success: true,
        message: 'پرداخت قبلاً تأیید شده است',
        orderId: payment.orderId,
      };
    }

    const terminalId = this.configService.get<string>('MELLAT_TERMINAL_ID')!;
    const userName = this.configService.get<string>('MELLAT_USERNAME')!;
    const userPassword = this.configService.get<string>('MELLAT_PASSWORD')!;

    /*
     * مقادیر لازم برای verify/settle:
     *
     * - orderId / saleOrderId: همان orderId که در bpPayRequest فرستادیم
     *   (در ستون saleOrderId ذخیره شده؛ برای رکوردهای قدیمی از callback می‌خوانیم)
     *
     * - saleReferenceId: کد مرجع تراکنشی که بانک در callback برمی‌گرداند
     */
    const gatewayOrderId = Number(
      payment.saleOrderId ?? callbackData?.saleOrderId,
    );
    const saleReferenceId = Number(
      payment.saleReferenceId ?? callbackData?.saleReferenceId,
    );

    if (!gatewayOrderId) {
      this.logger.error(
        `payment ${payment.id}: saleOrderId (شناسه سفارش نزد درگاه) موجود نیست`,
      );
      return {
        success: false,
        message: 'اطلاعات تراکنش ناقص است؛ با پشتیبانی تماس بگیرید',
        orderId: payment.orderId,
      };
    }

    if (!saleReferenceId) {
      this.logger.error(
        `payment ${payment.id}: saleReferenceId (کد مرجع بانک) موجود نیست`,
      );
      return {
        success: false,
        message: 'اطلاعات تراکنش ناقص است؛ با پشتیبانی تماس بگیرید',
        orderId: payment.orderId,
      };
    }

    // ذخیره برای ردگیری و استفاده در تلاش‌های بعدی verify
    payment.saleOrderId = gatewayOrderId;
    payment.saleReferenceId = saleReferenceId;
    await this.paymentRepo.save(payment);

    const bpPayload = {
      terminalId: Number(terminalId),
      userName,
      userPassword,
      orderId: gatewayOrderId,
      saleOrderId: gatewayOrderId,
      saleReferenceId,
    };

    try {
      const client = await this.getClient();

      // ۱. تأیید (کد 43 یعنی قبلاً تأیید شده)
      const verifyResult = await client.bpVerifyRequestAsync(bpPayload);
      const verifyResCode = verifyResult[0].return;

      if (verifyResCode !== '0' && verifyResCode !== '43') {
        payment.status = PaymentStatus.FAILED;
        payment.resCode = verifyResCode;
        await this.paymentRepo.save(payment);
        await this.ordersService.failOrderPayment(payment.orderId);
        return { success: false, message: `تأیید ناموفق: کد ${verifyResCode}` };
      }

      // ۲. واریز (کد 45 یعنی قبلاً واریز شده)
      const settleResult = await client.bpSettleRequestAsync(bpPayload);
      const settleResCode = settleResult[0].return;

      if (settleResCode !== '0' && settleResCode !== '45') {
        payment.status = PaymentStatus.FAILED;
        payment.resCode = settleResCode;
        await this.paymentRepo.save(payment);
        await this.ordersService.failOrderPayment(payment.orderId);
        return { success: false, message: `واریز ناموفق: کد ${settleResCode}` };
      }

      // ۳. موفق — پول دریافت شده است
      payment.status = PaymentStatus.SUCCESS;
      payment.resCode = '0';
      await this.paymentRepo.save(payment);

      // ۴. تأیید نهایی سفارش (کاهش موجودی + خالی کردن سبد)
      // اگر این مرحله خطا بدهد، پول گرفته شده؛ پس پرداخت را SUCCESS نگه می‌داریم
      // و سفارش را لغو نمی‌کنیم تا manually بررسی/اصلاح شود.
      try {
        await this.ordersService.confirmOrderPayment(payment.orderId);
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
       * خطای شبکه/SOAP: وضعیت واقعی تراکنش نامشخص است.
       * پرداخت را FAILED نمی‌کنیم و سفارش را لغو نمی‌کنیم
       * تا امکان verify مجدد/بررسی دستی وجود داشته باشد.
       */
      this.logger.error(
        `❌ خطا در ارتباط با درگاه ملت برای پرداخت ${payment.id} (order ${payment.orderId}). ` +
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

  async findPaymentByRefId(refId: string) {
    return this.paymentRepo.findOne({
      where: {
        refId,
        gateway: PaymentGateway.MELLAT,
      },
    });
  }

  async failPayment(payment: Payment, resCode: string) {
    payment.status = PaymentStatus.FAILED;
    payment.resCode = resCode;

    return this.paymentRepo.save(payment);
  }
}
