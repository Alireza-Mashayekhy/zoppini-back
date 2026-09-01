import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { OrdersService } from 'src/order/order.service';

import { RequestPaymentDto } from './dto/request-payment.dto';
import { PaymentGateway } from './entities/payment.entity';
import { DigipayPaymentService } from './services/digipay-payment.service';
import { MellatPaymentService } from './services/mellat-payment.service';
import { TaraPaymentService } from './services/tara-payment.service';
import { ZarinpalPaymentService } from './services/zarinpal-payment.service';

/** درخواست همراه با اطلاعات کاربر — AuthGuard تضمین می‌کند که user ست شده است */
type AuthenticatedRequest = Request & { user: { id: number } };

@Controller('payment')
export class PaymentController {
  constructor(
    private readonly mellatService: MellatPaymentService,
    private readonly zarinpalService: ZarinpalPaymentService,
    private readonly digipayService: DigipayPaymentService,
    private readonly taraService: TaraPaymentService,
    private readonly ordersService: OrdersService,
  ) {}

  private redirect(
    res: Response,
    status: 'success' | 'failed',
    orderId?: number | string,
  ) {
    let url = `${process.env.FRONT_URL}/checkout/payment/result?status=${status}`;

    if (orderId) {
      url += `&orderId=${orderId}`;
    }

    return res.redirect(url);
  }

  //==============================================================
  // Start Payment
  //==============================================================

  @Post('start')
  @UseGuards(AuthGuard)
  async startPayment(
    @Req() req: AuthenticatedRequest,
    @Body() dto: RequestPaymentDto,
  ) {
    // فقط مالک سفارش می‌تواند برای آن درخواست پرداخت بدهد
    const { id: userId } = req.user;

    switch (dto.gateway) {
      case PaymentGateway.MELLAT:
        return this.mellatService.requestPayment(dto.orderId, userId);

      case PaymentGateway.ZARINPAL:
        return this.zarinpalService.requestPayment(dto.orderId, userId);

      case PaymentGateway.DIGIPAY:
        return this.digipayService.requestPayment(dto.orderId, userId);

      case PaymentGateway.TARA:
        return this.taraService.requestPayment(dto.orderId, userId);

      default:
        throw new Error('درگاه پشتیبانی نمی‌شود');
    }
  }

  //==============================================================
  // Mellat
  //==============================================================

  @Post('callback/mellat')
  async callbackMellat(@Req() req, @Res() res) {
    // بانک ملت این مقادیر را در بدنه callback می‌فرستد
    // (نام فیلدها در مستندات/نسخه‌های مختلف با حروف بزرگ/کوچک آمده؛ هر دو را می‌خوانیم)
    const { RefId, ResCode } = req.body;
    const saleOrderId = req.body.saleOrderId ?? req.body.SaleOrderId;
    const saleReferenceId =
      req.body.saleReferenceId ?? req.body.SaleReferenceId;

    if (!RefId) {
      return this.redirect(res, 'failed');
    }

    if (ResCode !== '0') {
      const payment = await this.mellatService.findPaymentByRefId(RefId);

      if (payment) {
        await this.mellatService.failPayment(payment, ResCode);
        await this.ordersService.failOrderPayment(payment.orderId);

        return this.redirect(res, 'failed', payment.orderId);
      }

      return this.redirect(res, 'failed');
    }

    const result = await this.mellatService.verifyPayment(RefId, {
      saleOrderId,
      saleReferenceId,
    });

    return this.redirect(
      res,
      result.success ? 'success' : 'failed',
      result.orderId,
    );
  }

  //==============================================================
  // Zarinpal
  //==============================================================

  @Get('callback/zarinpal')
  async callbackZarinpal(
    @Query('Authority') authority: string,
    @Query('Status') status: string,
    @Res() res,
  ) {
    if (!authority) {
      return this.redirect(res, 'failed');
    }

    if (status !== 'OK') {
      const payment = await this.zarinpalService.findPaymentByRefId(authority);

      if (payment) {
        await this.zarinpalService.failPayment(payment, 'CANCELLED');
        await this.ordersService.failOrderPayment(payment.orderId);

        return this.redirect(res, 'failed', payment.orderId);
      }

      return this.redirect(res, 'failed');
    }

    const result = await this.zarinpalService.verifyPayment(authority);

    return this.redirect(
      res,
      result.success ? 'success' : 'failed',
      result.orderId,
    );
  }

  //==============================================================
  // Digipay
  //==============================================================

  @Post('callback/digipay')
  async callbackDigipay(@Req() req, @Res() res) {
    const { ticket, status } = req.body;

    if (!ticket) {
      return this.redirect(res, 'failed');
    }

    if (status !== 'success') {
      const payment = await this.digipayService.findPaymentByRefId(ticket);

      if (payment) {
        await this.digipayService.failPayment(payment);
        await this.ordersService.failOrderPayment(payment.orderId);

        return this.redirect(res, 'failed', payment.orderId);
      }

      return this.redirect(res, 'failed');
    }

    const result = await this.digipayService.verifyPayment(ticket);

    return this.redirect(
      res,
      result.success ? 'success' : 'failed',
      result.orderId,
    );
  }

  //==============================================================
  // Tara
  //==============================================================

  @Post('callback/tara')
  async callbackTara(@Req() req, @Res() res) {
    const { token, result } = req.body;

    if (!token) {
      return this.redirect(res, 'failed');
    }

    if (result !== '0') {
      const payment = await this.taraService.findPaymentByRefId(token);

      if (payment) {
        await this.taraService.failPayment(payment, result);
        await this.ordersService.failOrderPayment(payment.orderId);

        return this.redirect(res, 'failed', payment.orderId);
      }

      return this.redirect(res, 'failed');
    }

    const verify = await this.taraService.verifyPayment(token);

    return this.redirect(
      res,
      verify.success ? 'success' : 'failed',
      verify.orderId,
    );
  }
}
