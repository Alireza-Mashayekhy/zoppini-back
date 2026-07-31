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

    if (!refId) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed`,
      );
    }

    const payment = await this.mellatPaymentService['paymentRepo'].findOne({
      where: {
        refId,
        gateway: PaymentGateway.MELLAT,
      },
    });

    // پرداخت ناموفق
    if (resCode !== '0') {
      if (payment) {
        payment.status = 'failed' as any;
        payment.resCode = resCode;

        await this.mellatPaymentService['paymentRepo'].save(payment);

        await this.ordersService.failOrderPayment(payment.orderId);

        return res.redirect(
          `${process.env.APP_URL}/payment/result?status=failed&orderId=${payment.orderId}`,
        );
      }

      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed`,
      );
    }

    const result = await this.mellatPaymentService.verifyPayment(refId);

    if (result.success) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=success&orderId=${result.orderId}`,
      );
    }

    return res.redirect(
      `${process.env.APP_URL}/payment/result?status=failed&orderId=${result.orderId ?? payment?.orderId ?? ''}`,
    );
  }

  @Get('callback/zarinpal')
  async callbackZarinpal(
    @Query('Authority') authority: string,
    @Query('Status') status: string,
    @Response() res,
  ) {
    if (!authority) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed`,
      );
    }

    const payment = await this.zarinpalPaymentService['paymentRepo'].findOne({
      where: {
        refId: authority,
        gateway: PaymentGateway.ZARINPAL,
      },
    });

    if (!payment) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed`,
      );
    }

    if (status !== 'OK') {
      payment.status = 'failed' as any;
      payment.resCode = 'CANCELLED';

      await this.zarinpalPaymentService['paymentRepo'].save(payment);

      await this.ordersService.failOrderPayment(payment.orderId);

      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed&orderId=${payment.orderId}`,
      );
    }

    const result = await this.zarinpalPaymentService.verifyPayment(authority);

    if (result.success) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=success&orderId=${result.orderId}`,
      );
    }

    return res.redirect(
      `${process.env.APP_URL}/payment/result?status=failed&orderId=${result.orderId ?? payment.orderId}`,
    );
  }

  @Post('callback/digipay')
  async callbackDigipay(@Request() req, @Response() res) {
    const params = req.body;

    const ticket = params?.ticket;
    const status = params?.status;

    if (!ticket) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed`,
      );
    }

    const payment = await this.digipayPaymentService['paymentRepo'].findOne({
      where: {
        refId: ticket,
        gateway: PaymentGateway.DIGIPAY,
      },
    });

    if (!payment) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed`,
      );
    }

    if (status !== 'success') {
      payment.status = 'failed' as any;

      await this.digipayPaymentService['paymentRepo'].save(payment);

      await this.ordersService.failOrderPayment(payment.orderId);

      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed&orderId=${payment.orderId}`,
      );
    }

    const result = await this.digipayPaymentService.verifyPayment(ticket);

    if (result.success) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=success&orderId=${result.orderId}`,
      );
    }

    return res.redirect(
      `${process.env.APP_URL}/payment/result?status=failed&orderId=${result.orderId ?? payment.orderId}`,
    );
  }

  @Post('callback/tara')
  async callbackTara(@Request() req, @Response() res) {
    const params = req.body;

    const token = params?.token;
    const resultCode = params?.result;

    if (!token) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed`,
      );
    }

    const payment = await this.taraPaymentService['paymentRepo'].findOne({
      where: {
        refId: token,
        gateway: PaymentGateway.TARA,
      },
    });

    if (!payment) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed`,
      );
    }

    if (resultCode !== '0') {
      payment.status = 'failed' as any;
      payment.resCode = resultCode;

      await this.taraPaymentService['paymentRepo'].save(payment);

      await this.ordersService.failOrderPayment(payment.orderId);

      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=failed&orderId=${payment.orderId}`,
      );
    }

    const verifyResult = await this.taraPaymentService.verifyPayment(token);

    if (verifyResult.success) {
      return res.redirect(
        `${process.env.APP_URL}/payment/result?status=success&orderId=${verifyResult.orderId}`,
      );
    }

    return res.redirect(
      `${process.env.APP_URL}/payment/result?status=failed&orderId=${verifyResult.orderId ?? payment.orderId}`,
    );
  }

  @Get('result')
  paymentResult(
    @Query('status') status: string,
    @Query('orderId') orderId: string,
  ) {
    return { status, orderId };
  }
}
