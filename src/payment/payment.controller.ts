import {
  All,
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
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
import { getClientIp } from './utils/client-ip.util';
import { TARA_SUCCESS_RESULT } from './utils/tara.constants';

/** درخواست همراه با اطلاعات کاربر — AuthGuard تضمین می‌کند که user ست شده است */
type AuthenticatedRequest = Request & { user: { id: number } };

@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

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
        // فیلد ip در getToken/purchaseVerify تارا اجباری است و باید IP واقعی
        // کاربر باشد (خطاهای 1 = IP غیرمجاز و 88 = IP خالی)
        return this.taraService.requestPayment(
          dto.orderId,
          userId,
          getClientIp(req),
        );

      default:
        throw new BadRequestException('درگاه پشتیبانی نمی‌شود');
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

  /**
   * بند ۲-۴ مستند تارا: پس از انجام تراکنش، نتیجه به callBackUrl برگردانده
   * می‌شود و این پارامترها را دارد:
   *   result, desc, token, channelRefNumber, additionalData, orderId
   *
   * در مستند مشخص نشده که این مقادیر در query string می‌آیند یا در بدنهٔ
   * درخواست؛ پس هر دو حالت GET/POST و هر دو منبع خوانده می‌شود تا callback
   * هرگز بی‌نتیجه نماند.
   */
  @All('callback/tara')
  async callbackTara(@Req() req: Request, @Res() res: Response) {
    const source: Record<string, unknown> = { ...req.query, ...req.body };

    const readField = (key: string): string => {
      const value = source[key];
      const candidate = Array.isArray(value) ? value[value.length - 1] : value;

      if (typeof candidate === 'string') {
        return candidate.trim();
      }

      if (typeof candidate === 'number' || typeof candidate === 'boolean') {
        return String(candidate);
      }

      return '';
    };

    const token = readField('token');
    const result = readField('result');
    const desc = readField('desc');
    const channelRefNumber = readField('channelRefNumber');
    const additionalData = readField('additionalData');
    const callbackOrderId = readField('orderId');

    if (!token) {
      this.logger.warn('callback تارا بدون token دریافت شد.');

      return this.redirect(res, 'failed');
    }

    const payment = await this.taraService.findPaymentByRefId(token);

    if (!payment) {
      this.logger.warn(`callback تارا برای توکن ناشناخته: ${token}`);

      return this.redirect(res, 'failed');
    }

    /*
     * کنترل امنیتی: orderId برگشتی از تارا باید با سفارشِ این تراکنش یکی باشد
     * (همان orderId که در getToken فرستادیم).
     */
    if (callbackOrderId && callbackOrderId !== String(payment.orderId)) {
      this.logger.error(
        `❌ orderId نامعتبر در callback تارا: انتظار ${payment.orderId} بود ولی ${callbackOrderId} دریافت شد.`,
      );

      return this.redirect(res, 'failed', payment.orderId);
    }

    // ثبت اطلاعات callback (از جمله channelRefNumber که فقط تارا برمی‌گرداند)
    await this.taraService.storeCallbackData(payment, {
      result,
      desc,
      channelRefNumber,
      additionalData,
      orderId: callbackOrderId,
    });

    /*
     * طبق مستند: اگر result برابر با 0 (موفق) نبود، نباید purchaseVerify
     * صدا زده شود و مبلغ حداکثر تا ۳۰ دقیقه به‌صورت خودکار برگشت می‌خورد.
     */
    if (result !== TARA_SUCCESS_RESULT) {
      this.logger.warn(
        `تراکنش تارا ناموفق: ${payment.id} (result=${result || 'خالی'}${
          desc ? `, desc=${desc}` : ''
        })`,
      );

      await this.taraService.failPayment(payment, result || 'UNKNOWN');
      await this.ordersService.failOrderPayment(payment.orderId);

      return this.redirect(res, 'failed', payment.orderId);
    }

    try {
      const verify = await this.taraService.verifyPayment(
        token,
        getClientIp(req),
      );

      return this.redirect(
        res,
        verify.success ? 'success' : 'failed',
        verify.orderId ?? payment.orderId,
      );
    } catch (error) {
      /*
       * در هر خطای پیش‌بینی‌نشده کاربر باید صفحهٔ نتیجه را ببیند، نه خطای 500.
       * تراکنش PENDING می‌ماند تا با استعلام دستی/کرون مشخص شود.
       */
      this.logger.error(
        `❌ خطا در تأیید پرداخت تارا (پرداخت ${payment.id})`,
        error instanceof Error ? error.stack : String(error),
      );

      return this.redirect(res, 'failed', payment.orderId);
    }
  }
}
