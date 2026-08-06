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

@Injectable()
export class MellatPaymentService {
  private readonly logger = new Logger(MellatPaymentService.name);
  private wsClient: any;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
    private ordersService: OrdersService,
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
  ): Promise<{ refId: string; payUrl: string }> {
    const order = await this.ordersService.findOneForAdmin(orderId);
    if (!order) {
      throw new BadRequestException('سفارش یافت نشد');
    }

    const existingPayment = await this.paymentRepo.findOne({
      where: { orderId, gateway: PaymentGateway.MELLAT },
    });
    if (existingPayment && existingPayment.status === PaymentStatus.PENDING) {
      throw new BadRequestException('درخواست پرداخت قبلاً ثبت شده است');
    }

    // استفاده از ! برای اطمینان از وجود مقدار
    const terminalId = this.configService.get<string>('MELLAT_TERMINAL_ID')!;
    const userName = this.configService.get<string>('MELLAT_USERNAME')!;
    const userPassword = this.configService.get<string>('MELLAT_PASSWORD')!;
    const callbackUrl =
      this.configService.get<string>('APP_URL') + '/payment/callback/mellat';
    const payUrl = this.configService.get<string>('MELLAT_PAY_URL')!;

    const amount = Math.round(order.finalPrice * 10); // تبدیل تومان به ریال
    const localDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const localTime = new Date().toTimeString().slice(0, 8).replace(/:/g, '');

    const payload = {
      terminalId: Number(terminalId),
      userName,
      userPassword,
      orderId: Date.now(),
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

    const verifyPayload = {
      terminalId: Number(terminalId),
      userName,
      userPassword,
      orderId: payment.orderId,
      saleOrderId: payment.orderId,
      saleReferenceId: 0,
    };

    try {
      const client = await this.getClient();

      // ۱. تأیید
      const verifyResult = await client.bpVerifyRequestAsync(verifyPayload);
      const verifyResCode = verifyResult[0].return;

      if (verifyResCode !== '0' && verifyResCode !== '43') {
        payment.status = PaymentStatus.FAILED;
        payment.resCode = verifyResCode;
        await this.paymentRepo.save(payment);
        await this.ordersService.failOrderPayment(payment.orderId);
        return { success: false, message: `تأیید ناموفق: کد ${verifyResCode}` };
      }

      // ۲. واریز
      const settlePayload = {
        terminalId: Number(terminalId),
        userName,
        userPassword,
        orderId: payment.orderId,
        saleOrderId: payment.orderId,
        saleReferenceId: 0,
      };
      const settleResult = await client.bpSettleRequestAsync(settlePayload);
      const settleResCode = settleResult[0].return;

      if (settleResCode !== '0' && settleResCode !== '45') {
        payment.status = PaymentStatus.FAILED;
        payment.resCode = settleResCode;
        await this.paymentRepo.save(payment);
        await this.ordersService.failOrderPayment(payment.orderId);
        return { success: false, message: `واریز ناموفق: کد ${settleResCode}` };
      }

      // ۳. موفق
      payment.status = PaymentStatus.SUCCESS;
      payment.resCode = '0';
      await this.paymentRepo.save(payment);
      // ۴. تأیید نهایی سفارش و کاهش موجودی + خالی کردن سبد
      await this.ordersService.confirmOrderPayment(payment.orderId); // userId رو از کجا بیاریم؟ باید در Payment ذخیره کنیم یا از order بگیریم
      // در اینجا userId رو باید از order.user.id بگیریم، ولی چون order را داریم، می‌توانیم از آن استفاده کنیم
      // بهتر است در متد confirmOrderPayment فقط orderId بدهیم و userId را خودمان از order استخراج کنیم

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
