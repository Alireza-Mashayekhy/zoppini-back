import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  Response,
} from '@nestjs/common';
import { OrdersService } from 'src/order/order.service';

import { RequestPaymentDto } from './dto/request-payment.dto';
import { PaymentGateway } from './entities/payment.entity';
import { DigipayPaymentService } from './services/digipay-payment.service';
import { MellatPaymentService } from './services/mellat-payment.service';
import { TaraPaymentService } from './services/tara-payment.service';
import { ZarinpalPaymentService } from './services/zarinpal-payment.service';

@Controller('payment')
export class PaymentController {
  constructor(
    private mellatPaymentService: MellatPaymentService,
    private zarinpalPaymentService: ZarinpalPaymentService,
    private digipayPaymentService: DigipayPaymentService,
    private ordersService: OrdersService,
    private taraPaymentService: TaraPaymentService,
  ) {}

  @Post('start')
  async startPayment(@Body() dto: RequestPaymentDto) {
    if (dto.gateway === PaymentGateway.MELLAT) {
      return this.mellatPaymentService.requestPayment(dto.orderId);
    }
    if (dto.gateway === PaymentGateway.ZARINPAL) {
      return this.zarinpalPaymentService.requestPayment(dto.orderId);
    }
    if (dto.gateway === PaymentGateway.DIGIPAY) {
      return this.digipayPaymentService.requestPayment(dto.orderId);
    }
    if (dto.gateway === PaymentGateway.TARA) {
      return this.taraPaymentService.requestPayment(dto.orderId);
    }
    throw new Error('درگاه انتخاب شده پشتیبانی نمی‌شود');
  }

  @Post('request')
  async requestPayment(@Body() dto: RequestPaymentDto) {
    if (dto.gateway === PaymentGateway.MELLAT) {
      return this.mellatPaymentService.requestPayment(dto.orderId);
    }
    throw new Error('درگاه انتخاب شده پشتیبانی نمی‌شود');
  }

  @Post('callback/mellat')
  async callbackMellat(@Request() req, @Response() res) {
    const params = req.body;
    const refId = params?.RefId;
    const resCode = params?.ResCode;

    if (resCode !== '0') {
      const payment = await this.mellatPaymentService['paymentRepo'].findOne({
        where: { refId },
      });
      if (payment) {
        payment.status = 'failed' as any;
        payment.resCode = resCode;
        await this.mellatPaymentService['paymentRepo'].save(payment);
      }
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed&refId=${refId}`,
      );
    }

    const result = await this.mellatPaymentService.verifyPayment(refId);
    if (result.success) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=success&orderId=${result.orderId}`,
      );
    } else {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed&refId=${refId}`,
      );
    }
  }

  @Post('callback/zarinpal')
  async callbackZarinpal(@Request() req, @Response() res) {
    const params = req.body;
    const authority = params?.authority;
    const status = params?.status;

    // status = 'OK' یا 'NOK'
    if (status !== 'OK') {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed&refId=${authority}`,
      );
    }

    const result = await this.zarinpalPaymentService.verifyPayment(authority);
    if (result.success) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=success&orderId=${result.orderId}`,
      );
    } else {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed&refId=${authority}`,
      );
    }
  }

  @Post('callback/digipay')
  async callbackDigipay(@Request() req, @Response() res) {
    const params = req.body;
    const ticket = params?.ticket;
    const status = params?.status; // ممکن است 'success' یا 'failed' باشد

    if (!ticket) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed`,
      );
    }

    // اگر وضعیت از سمت دیجی‌پی ناموفق باشد
    if (status !== 'success') {
      // می‌توانیم مستقیماً failOrderPayment را صدا بزنیم
      const payment = await this.digipayPaymentService['paymentRepo'].findOne({
        where: { refId: ticket, gateway: PaymentGateway.DIGIPAY },
      });
      if (payment) {
        payment.status = 'failed' as any;
        await this.digipayPaymentService['paymentRepo'].save(payment);
        await this.ordersService.failOrderPayment(payment.orderId);
      }
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed&refId=${ticket}`,
      );
    }

    // در غیر این صورت، تأیید نهایی را انجام بده
    const result = await this.digipayPaymentService.verifyPayment(ticket);
    if (result.success) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=success&orderId=${result.orderId}`,
      );
    } else {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed&refId=${ticket}`,
      );
    }
  }

  @Post('callback/tara')
  async callbackTara(@Request() req, @Response() res) {
    const params = req.body;
    const token = params?.token;
    const result = params?.result; // '0' یعنی موفق
    const orderId = params?.orderId;

    if (!token) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed`,
      );
    }

    // اگر پرداخت ناموفق بوده
    if (result !== '0') {
      const payment = await this.taraPaymentService['paymentRepo'].findOne({
        where: { refId: token, gateway: PaymentGateway.TARA },
      });
      if (payment) {
        payment.status = 'failed' as any;
        payment.resCode = result;
        await this.taraPaymentService['paymentRepo'].save(payment);
        await this.ordersService.failOrderPayment(payment.orderId);
      }
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed&refId=${token}`,
      );
    }

    // تأیید نهایی پرداخت
    const verifyResult = await this.taraPaymentService.verifyPayment(token);
    if (verifyResult.success) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=success&orderId=${verifyResult.orderId}`,
      );
    } else {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed&refId=${token}`,
      );
    }
  }

  @Get('result')
  paymentResult(
    @Query('status') status: string,
    @Query('orderId') orderId: string,
  ) {
    return { status, orderId };
  }
}
