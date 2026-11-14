import {
  All,
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AnalyticsService } from 'src/analytics/analytics.service';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { OrdersService } from 'src/order/order.service';

import { DigipayAdminRefundDto } from './dto/digipay-admin.dto';
import { RequestPaymentDto } from './dto/request-payment.dto';
import {
  SnappayAdminCancelDto,
  SnappayAdminUpdateDto,
} from './dto/snappay-admin.dto';
import { SnappayEligibilityDto } from './dto/snappay-eligibility.dto';
import { StartWalletChargeDto } from './dto/start-wallet-charge.dto';
import { PaymentGateway, PaymentPurpose } from './entities/payment.entity';
import { DigipayPaymentService } from './services/digipay-payment.service';
import { MellatPaymentService } from './services/mellat-payment.service';
import { SnappayPaymentService } from './services/snappay-payment.service';
import { TaraPaymentService } from './services/tara-payment.service';
import { WalletChargeService } from './services/wallet-charge.service';
import { ZarinpalPaymentService } from './services/zarinpal-payment.service';
import { readCallbackFieldAny } from './utils/callback-fields.util';
import { normalizePublicBaseUrl } from './utils/callback-url.util';
import { getClientIp } from './utils/client-ip.util';
import { isMellatInconclusive, MELLAT_SUCCESS } from './utils/mellat.constants';
import { TARA_SUCCESS_RESULT } from './utils/tara.constants';

/** درخواست همراه با اطلاعات کاربر — AuthGuard تضمین می‌کند که user ست شده است */
type AuthenticatedRequest = Request & { user: { id: number } };

/** خلاصهٔ کوتاه و امنِ بدنه/کوئری callback برای لاگ عیب‌یابی */
function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value ?? {}) ?? '';

    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return '[unserializable]';
  }
}

@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly mellatService: MellatPaymentService,
    private readonly zarinpalService: ZarinpalPaymentService,
    private readonly digipayService: DigipayPaymentService,
    private readonly taraService: TaraPaymentService,
    private readonly snappayService: SnappayPaymentService,
    private readonly ordersService: OrdersService,
    private readonly analyticsService: AnalyticsService,
    private readonly walletChargeService: WalletChargeService,
  ) {}

  private frontUrlWarned = false;

  /**
   * آدرس سایت (سمت کاربر) برای صفحهٔ نتیجه.
   *
   * اگر `FRONT_URL` تنظیم نشده باشد، مثل قبل رشتهٔ «undefined» در آدرس
   * نمی‌نشیند و از دامنهٔ `APP_URL` استفاده می‌شود (بدون `/api`).
   */
  private getFrontUrl(): string {
    const explicit = normalizePublicBaseUrl(process.env.FRONT_URL);

    if (explicit) {
      return explicit;
    }

    const fallback = normalizePublicBaseUrl(process.env.APP_URL);

    if (!this.frontUrlWarned) {
      this.frontUrlWarned = true;
      this.logger.warn(
        fallback
          ? `FRONT_URL تنظیم نشده است؛ صفحهٔ نتیجه با دامنهٔ APP_URL (${fallback}) باز می‌شود.`
          : 'هیچ‌کدام از FRONT_URL و APP_URL تنظیم نشده‌اند؛ کاربر به صفحهٔ نتیجه هدایت نمی‌شود.',
      );
    }

    return fallback;
  }

  private redirect(
    res: Response,
    status: 'success' | 'failed' | 'pending',
    orderId?: number | string,
  ) {
    const frontUrl = this.getFrontUrl();
    let url = `${frontUrl}/checkout/payment/result?status=${status}`;

    if (!frontUrl) {
      // بدون دامنهٔ سایت، redirect نسبی همیشه کار می‌کند
      url = `/checkout/payment/result?status=${status}`;
    }

    if (orderId) {
      url += `&orderId=${orderId}`;
    }

    return res.redirect(url);
  }

  // private sendVerifySmsToUser(username: string, link: string) {
  //   const result = await this.sendSms(this.adminPhone, message);
  //   return { success: result.success };
  // }

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

    await this.analyticsService.checkout(
      dto.orderId,
      userId,
      String(req.headers['x-analytics-context'] ?? ''),
    );

    switch (dto.gateway) {
      case PaymentGateway.MELLAT:
        return this.mellatService.requestPayment(dto.orderId, userId);

      case PaymentGateway.ZARINPAL:
        return this.zarinpalService.requestPayment(dto.orderId, userId);

      case PaymentGateway.DIGIPAY:
        return this.digipayService.requestPayment(dto.orderId, userId);

      case PaymentGateway.TARA:
        return this.taraService.requestPayment(
          dto.orderId,
          userId,
          getClientIp(req),
        );

      case PaymentGateway.SNAPPAY:
        return this.snappayService.requestPayment(dto.orderId, userId);

      default:
        throw new BadRequestException('درگاه پشتیبانی نمی‌شود');
    }
  }

  /**
   * بررسی امکان پرداخت اسنپ‌پی برای نمایش در چک‌اوت.
   * عنوان و توضیح پاسخ دقیقاً همان مقادیر داینامیک اسنپ‌پی است و با هر
   * تغییر مبلغ باید دوباره فراخوانی شود؛ در صورت eligible=false این روش
   * پرداخت نباید نمایش داده شود.
   */
  @Get('snappay/eligibility')
  @UseGuards(AuthGuard)
  async snappayEligibility(
    @Req() req: AuthenticatedRequest,
    @Query() dto: SnappayEligibilityDto,
  ) {
    return this.snappayService.getEligibility(req.user.id, dto);
  }

  @Post('start-wallet-charge')
  @UseGuards(AuthGuard)
  async startWalletCharge(
    @Req() req: AuthenticatedRequest,
    @Body() dto: StartWalletChargeDto,
  ) {
    const { id: userId } = req.user;

    // اسنپ‌پی اعتبار خرید کالاست و برای شارژ کیف پول استفاده نمی‌شود
    if (dto.gateway === PaymentGateway.SNAPPAY) {
      throw new BadRequestException(
        'شارژ کیف پول با اسنپ‌پی امکان‌پذیر نیست؛ اسنپ‌پی فقط برای پرداخت سفارش است',
      );
    }

    const charge = await this.walletChargeService.createPendingCharge(
      userId,
      dto.amount,
      dto.gateway,
    );

    try {
      switch (dto.gateway) {
        case PaymentGateway.MELLAT:
          return await this.mellatService.requestWalletCharge(
            charge.id,
            userId,
          );

        case PaymentGateway.ZARINPAL:
          return await this.zarinpalService.requestWalletCharge(
            charge.id,
            userId,
          );

        case PaymentGateway.DIGIPAY:
          return await this.digipayService.requestWalletCharge(
            charge.id,
            userId,
          );

        case PaymentGateway.TARA:
          return await this.taraService.requestWalletCharge(
            charge.id,
            userId,
            getClientIp(req),
          );

        default:
          throw new BadRequestException('درگاه پشتیبانی نمی‌شود');
      }
    } catch (error) {
      // درخواست درگاه شکست خورد؛ شارژ را FAILED ثبت می‌کنیم
      await this.walletChargeService.markChargeFailedById(charge.id);
      throw error;
    }
  }

  //==============================================================
  // Mellat
  //==============================================================

  @Post('callback/mellat')
  async callbackMellat(@Req() req: Request, @Res() res: Response) {
    const refId = readCallbackFieldAny(req, ['RefId', 'refId', 'RefID']);
    const resCode = readCallbackFieldAny(req, ['ResCode', 'resCode']);
    const saleOrderId = readCallbackFieldAny(req, [
      'SaleOrderId',
      'saleOrderId',
    ]);
    const saleReferenceId = readCallbackFieldAny(req, [
      'SaleReferenceId',
      'saleReferenceId',
    ]);
    const cardHolderPan = readCallbackFieldAny(req, [
      'CardHolderPan',
      'cardHolderPan',
      'CardHolderPAN',
    ]);
    const creditCardSaleResponseDetail = readCallbackFieldAny(req, [
      'CreditCardSaleResponseDetail',
    ]);
    const finalAmount = readCallbackFieldAny(req, [
      'FinalAmount',
      'finalAmount',
    ]);

    if (!refId) {
      this.logger.warn('callback ملت بدون RefId دریافت شد.');

      return this.redirect(res, 'failed');
    }

    const payment = await this.mellatService.findPaymentByRefId(refId);

    if (!payment) {
      this.logger.warn(`callback ملت برای RefId ناشناخته: ${refId}`);

      return this.redirect(res, 'failed');
    }

    try {
      /*
       * اگر بانک SaleReferenceId برنگردانده باشد، چیزی برای verify وجود ندارد؛
       * در این حالت فقط کدهای قطعی (مثلاً ۱۷ = انصراف کاربر) ناموفق ثبت
       * می‌شوند. کدهای نامشخص (مثلاً ۱۱۳ = پاسخی از سامانهٔ مقصد دریافت نشد)
       * تراکنش را بلاتکلیف نگه می‌دارند تا زمان‌بند استعلام بگیرد.
       */
      if (!saleReferenceId) {
        if (
          resCode &&
          resCode !== MELLAT_SUCCESS &&
          !isMellatInconclusive(resCode)
        ) {
          const rejected = await this.mellatService.rejectFromCallback(
            payment,
            resCode,
          );

          return this.redirect(
            res,
            'failed',
            rejected.orderId ?? payment.orderId ?? undefined,
          );
        }

        this.logger.warn(
          `callback ملت برای پرداخت ${payment.id} بدون SaleReferenceId بود (ResCode=${resCode || 'خالی'}).`,
        );

        return this.redirect(res, 'failed', payment.orderId ?? undefined);
      }

      /*
       * طبق مستند، حتی وقتی ResCode غیر از صفر است هم «می‌بایست تابع
       * bpVerifyRequest مجدداً فراخوانی گردد تا پاسخ مناسب دریافت شود»؛
       * پس همیشه verify صدا زده می‌شود. کنترل امنیتی همخوانی SaleOrderId
       * با مقدار ارسالی در bpPayRequest هم داخل همان سرویس انجام می‌شود.
       */
      const result = await this.mellatService.verifyPayment(refId, {
        resCode,
        saleOrderId,
        saleReferenceId,
        cardHolderPan,
        finalAmount,
        creditCardSaleResponseDetail,
      });

      return this.redirect(
        res,
        result.success ? 'success' : 'failed',
        result.orderId ?? payment.orderId ?? undefined,
      );
    } catch (error) {
      // کاربر باید صفحهٔ نتیجه را ببیند، نه خطای ۵۰۰
      this.logger.error(
        `❌ خطا در پردازش callback ملت (پرداخت ${payment.id})`,
        error instanceof Error ? error.stack : String(error),
      );

      return this.redirect(res, 'failed', payment.orderId ?? undefined);
    }
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
    this.logger.log(
      `↩️ callback زرین‌پال دریافت شد: Authority=${authority}, Status=${status}`,
    );
    if (!authority) {
      this.logger.warn('callback زرین‌پال بدون Authority دریافت شد.');
      return this.redirect(res, 'failed');
    }

    if (status !== 'OK') {
      const payment = await this.zarinpalService.findPaymentByRefId(authority);

      if (payment) {
        this.logger.warn(
          `پرداخت ${payment.id} توسط کاربر لغو شد (Status=${status}).`,
        );
        await this.zarinpalService.failPayment(payment, 'CANCELLED');

        if (payment.purpose === PaymentPurpose.ORDER) {
          await this.ordersService.failOrderPayment(payment.orderId!);
        } else {
          await this.walletChargeService.markChargeFailed(payment);
        }

        return this.redirect(res, 'failed', payment.orderId ?? undefined);
      }

      return this.redirect(res, 'failed');
    }

    const result = await this.zarinpalService.verifyPayment(authority);

    this.logger.log(
      `🏁 نتیجهٔ verify زرین‌پال برای Authority=${authority}: success=${result.success}, message=${result.message}`,
    );

    return this.redirect(
      res,
      result.success ? 'success' : 'failed',
      result.orderId,
    );
  }

  //==============================================================
  // Digipay
  //==============================================================

  /**
   * نتیجهٔ پرداخت دیجی‌پی (بند ۸ مستند UPG).
   *
   * مسیر موفق معمولاً **POST** است، ولی در «انصراف» ممکن است بازگشت **GET با
   * بدنهٔ خالی** باشد؛ پس هر دو متد و هم بدنه هم query خوانده می‌شود. دریافت
   * callback به‌تنهایی اثبات پرداخت نیست و نتیجه فقط با `purchases/verify`
   * نهایی می‌شود.
   */
  @All('callback/digipay')
  @SkipThrottle()
  async callbackDigipay(@Req() req: Request, @Res() res: Response) {
    /*
     * طبق مستند UPG، دیجی‌پی نتیجه را با POST و این فیلدها می‌فرستد:
     * amount, providerId, trackingCode, rrn, psp, isCredit, creditProvider,
     * repaymentOption, result, type
     * (ticket/status که قبلاً اینجا خوانده می‌شد مربوط به قرارداد دیگری بود.)
     */
    const rawBody = req.body as Record<string, unknown> | undefined;
    const rawPsp = rawBody?.psp;
    const psp = rawPsp && typeof rawPsp === 'object' ? rawPsp : undefined;
    const callback = {
      amount: readCallbackFieldAny(req, ['amount', 'Amount']),
      providerId: readCallbackFieldAny(req, ['providerId', 'ProviderId']),
      trackingCode: readCallbackFieldAny(req, ['trackingCode', 'TrackingCode']),
      rrn: readCallbackFieldAny(req, ['rrn', 'Rrn', 'RRN']),
      psp,
      isCredit: readCallbackFieldAny(req, ['isCredit', 'IsCredit']),
      creditProvider: readCallbackFieldAny(req, [
        'creditProvider',
        'CreditProvider',
      ]),
      repaymentOption: readCallbackFieldAny(req, [
        'repaymentOption',
        'RepaymentOption',
      ]),
      type: readCallbackFieldAny(req, ['type', 'Type']),
      result: readCallbackFieldAny(req, ['result', 'Result']),
    };

    const payment =
      (callback.providerId
        ? await this.digipayService.findPaymentByProviderId(callback.providerId)
        : null) ??
      // بازگشت‌های تکراری/بدون providerId: با کد پیگیری هم قابل تطبیق است
      (callback.trackingCode
        ? await this.digipayService.findPaymentBySaleReferenceId(
            callback.trackingCode,
          )
        : null);

    if (!payment) {
      /*
       * انصراف کاربر یا بازگشت خالی: سفارش را پرداخت‌شده فرض نمی‌کنیم و
       * کاربر به صفحهٔ نتیجهٔ ناموفق می‌رود. سفارش PENDING می‌ماند تا
       * بتواند دوباره پرداخت کند.
       */
      this.logger.warn(
        `callback دیجی‌پی بدون تطبیق با پرداخت ثبت‌شده دریافت شد (` +
          `providerId=${callback.providerId || 'خالی'}, ` +
          `trackingCode=${callback.trackingCode || 'خالی'}, ` +
          `result=${callback.result || 'خالی'}, method=${req.method})`,
      );

      return this.redirect(res, 'failed');
    }

    const normalizedResult = callback.result.toUpperCase();

    if (normalizedResult === 'FAILURE') {
      const result = await this.digipayService.failPayment(
        payment,
        callback.result || 'FAILURE',
        callback,
      );

      return this.redirect(
        res,
        result.pending ? 'pending' : result.success ? 'success' : 'failed',
        result.orderId ?? payment.orderId ?? undefined,
      );
    }

    /*
     * طبق مستند، `result` ممکن است در بازگشت موجود نباشد (به‌خصوص خرید با
     * کیف پول دیجی‌پی)؛ «نبودن result» را شکست نمی‌دانیم و verify را انجام
     * می‌دهیم. مقدار ناشناخته‌ی غیرخالی را محافظه‌کارانه «در حال بررسی»
     * می‌گیریم.
     */
    if (normalizedResult && normalizedResult !== 'SUCCESS') {
      await this.digipayService.recordCallback(payment, callback);

      return this.redirect(res, 'pending', payment.orderId ?? undefined);
    }

    const result = await this.digipayService.verifyPayment(payment, callback);

    return this.redirect(
      res,
      result.pending ? 'pending' : result.success ? 'success' : 'failed',
      result.orderId ?? payment.orderId ?? undefined,
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
    const token = readCallbackFieldAny(req, ['token', 'Token']);
    const result = readCallbackFieldAny(req, ['result', 'Result']);
    const desc = readCallbackFieldAny(req, ['desc', 'Desc', 'description']);
    const channelRefNumber = readCallbackFieldAny(req, [
      'channelRefNumber',
      'ChannelRefNumber',
    ]);
    const additionalData = readCallbackFieldAny(req, [
      'additionalData',
      'AdditionalData',
    ]);
    const callbackOrderId = readCallbackFieldAny(req, ['orderId', 'OrderId']);

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
    const expectedOrderId =
      payment.purpose === PaymentPurpose.WALLET_CHARGE
        ? String(payment.walletChargeId ?? '')
        : String(payment.orderId ?? '');

    if (callbackOrderId && callbackOrderId !== expectedOrderId) {
      this.logger.error(
        `❌ orderId نامعتبر در callback تارا: انتظار ${expectedOrderId} بود ولی ${callbackOrderId} دریافت شد.`,
      );
      return this.redirect(res, 'failed', payment.orderId ?? undefined);
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
      if (payment.purpose === PaymentPurpose.ORDER) {
        await this.ordersService.failOrderPayment(payment.orderId!);
      } else {
        await this.walletChargeService.markChargeFailed(payment);
      }

      return this.redirect(res, 'failed', payment.orderId ?? undefined);
    }

    try {
      const verify = await this.taraService.verifyPayment(
        token,
        getClientIp(req),
      );

      return this.redirect(
        res,
        verify.success ? 'success' : 'failed',
        verify.orderId ?? payment.orderId ?? undefined,
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

      return this.redirect(res, 'failed', payment.orderId ?? undefined);
    }
  }

  //==============================================================
  // SnappPay
  //==============================================================

  /**
   * نتیجهٔ پرداخت اسنپ‌پی طبق مستند با POST فرم و این پارامترها به
   * returnURL برمی‌گردد: transactionId, state (OK/FAILED), amount (ریال)
   *
   * برای اطمینان از گم نشدن callback، مثل تارا هر دو متد و هر دو منبع
   * (بدنه/query) خوانده می‌شود؛ امنیت نهایی با تطبیق مبلغ و فراخوانی
   * سمت سرور verify/settle/status برقرار است، نه با خود این درخواست.
   * callback تکراری هم بی‌خطر است و verify دوم ساخته نمی‌شود.
   *
   * callback درگاه هیچ‌وقت نباید با rate-limit رد شود (مثل دیجی‌پی).
   */
  @All('callback/snappay')
  @SkipThrottle()
  async callbackSnappay(@Req() req: Request, @Res() res: Response) {
    const transactionId = readCallbackFieldAny(req, [
      'transactionId',
      'TransactionId',
      'transaction_id',
      'transactionID',
      'TransactionID',
    ]);
    const state = readCallbackFieldAny(req, ['state', 'State']);
    const amount = readCallbackFieldAny(req, ['amount', 'Amount']);
    const paymentToken = readCallbackFieldAny(req, [
      'paymentToken',
      'PaymentToken',
      'payment_token',
      'token',
      'Token',
      'refId',
      'RefId',
    ]);
    const orderId = readCallbackFieldAny(req, [
      'orderId',
      'OrderId',
      'order_id',
    ]);

    const hasField = Boolean(
      transactionId || state || amount || paymentToken || orderId,
    );
    const hasBody =
      Number(req.headers['content-length'] ?? 0) > 0 ||
      Object.keys((req.body as Record<string, unknown>) ?? {}).length > 0;
    const hasQuery = Object.keys(req.query ?? {}).length > 0;

    /*
     * باز کردن دستی این آدرس در مرورگر (برای تست) هیچ پرداختی را تغییر
     * نمی‌دهد؛ به‌جای صفحهٔ گمراه‌کنندهٔ «پرداخت ناموفق» پاسخ روشن می‌دهد
     * که مسیر در دسترس است و منتظر POST اسنپ‌پی است.
     *
     * اگر درخواست بدنه/کوئری داشته ولی هیچ فیلدی از آن خوانده نشده (مثلاً
     * Content-Type غیرمنتظره)، این حالت «تست دستی» نیست و پایین‌تر به‌عنوان
     * callback ناشناخته پردازش می‌شود.
     */
    if (!hasField && !hasBody && !hasQuery) {
      return res.status(200).json({
        received: true,
        gateway: PaymentGateway.SNAPPAY,
        callbackUrl: this.snappayService.getCallbackUrlOrEmpty(),
        message:
          'این آدرس فقط برای بازگشت از درگاه اسنپ‌پی است؛ نتیجهٔ پرداخت را خود اسنپ‌پی با POST به این مسیر می‌فرستد.',
      });
    }

    // لاگ کامل ورودی برای عیب‌یابی callback (مقدار حساسی در آن نیست)
    this.logger.log(
      `↩️ callback اسنپ‌پی: method=${req.method}, state=${state || 'خالی'}, ` +
        `amount=${amount || 'خالی'}, transactionId=${transactionId || 'خالی'}, ` +
        `paymentToken=${paymentToken ? 'دارد' : 'خالی'}, orderId=${orderId || 'خالی'}, ` +
        `body=${safeJson(req.body)} query=${safeJson(req.query)}`,
    );

    const payment = await this.snappayService.resolveCallbackPayment({
      transactionId,
      paymentToken,
      orderId,
    });

    if (!payment) {
      /*
       * به هیچ پرداختی تطبیق داده نشد. «ناموفق» گفتن به کاربر غلط است، چون
       * ممکن است callback یک پرداخت واقعی باشد که ما رکوردش را پیدا نکردیم
       * و پول هم گرفته شده باشد؛ فقط اگر خود اسنپ‌پی state=FAILED فرستاده
       * باشد نتیجه «ناموفق» اعلام می‌شود.
       */
      this.logger.error(
        `❌ callback اسنپ‌پی به هیچ پرداختی تطبیق داده نشد ` +
          `(transactionId=${transactionId || 'خالی'}, orderId=${orderId || 'خالی'}, ` +
          `body=${safeJson(req.body)} query=${safeJson(req.query)}). ` +
          `آدرس بازگشت فعلی: ${this.snappayService.getCallbackUrlOrEmpty() || 'تنظیم نشده'}`,
      );

      return this.redirect(
        res,
        state?.trim().toUpperCase() === 'FAILED' ? 'failed' : 'pending',
        orderId || undefined,
      );
    }

    try {
      const result = await this.snappayService.handleCallback(payment, {
        transactionId: transactionId || payment.providerId || '',
        state,
        amount,
      });

      return this.redirect(
        res,
        result.pending ? 'pending' : result.success ? 'success' : 'failed',
        result.orderId ?? payment.orderId ?? undefined,
      );
    } catch (error) {
      /*
       * خطای پیش‌بینی‌نشده: ممکن است وجه در اسنپ‌پی پرداخت شده باشد، پس
       * کاربر صفحهٔ «در حال بررسی» را می‌بیند و scheduler با استعلام
       * وضعیت تکلیف تراکنش را روشن می‌کند.
       */
      this.logger.error(
        `❌ خطا در پردازش callback اسنپ‌پی (پرداخت ${payment.id})`,
        error instanceof Error ? error.stack : String(error),
      );

      return this.redirect(res, 'pending', payment.orderId ?? undefined);
    }
  }

  /**
   * عیب‌یابی درگاه اسنپ‌پی (فقط ادمین): آدرس بازگشتی که دقیقاً به اسنپ‌پی
   * داده می‌شود + آخرین تلاش‌های پرداخت و callback ثبت‌شدهٔ هر کدام.
   */
  @Get('snappay/admin/diagnostics')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async snappayDiagnostics(@Query('limit') limit?: string) {
    return this.snappayService.getDiagnostics(Number(limit) || 10);
  }

  /**
   * لغو کامل تراکنش settle‌شدهٔ اسنپ‌پی توسط ادمین (برگشت‌ناپذیر).
   * بدنه: { "confirm": true, "cancelOrder": true, "reason": "..." }
   */
  @Post('snappay/admin/payments/:paymentId/cancel')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async snappayAdminCancel(
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: SnappayAdminCancelDto,
  ) {
    return this.snappayService.adminCancelPayment(paymentId, dto);
  }

  /**
   * کم کردن مبلغ/اقلام تراکنش settle‌شدهٔ اسنپ‌پی توسط ادمین
   * (برگشت‌ناپذیر). بدنه: { "confirm": true, "items": [{ "orderItemId": 1, "count": 0 }] }
   */
  @Post('snappay/admin/payments/:paymentId/update')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async snappayAdminUpdate(
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: SnappayAdminUpdateDto,
  ) {
    return this.snappayService.adminUpdatePayment(paymentId, dto);
  }

  /** استعلام و پیش‌برد دستی یک پرداخت اسنپ‌پی (همان مسیری که cron می‌رود) */
  @Post('snappay/admin/payments/:paymentId/reconcile')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async snappayAdminReconcile(
    @Param('paymentId', ParseIntPipe) paymentId: number,
  ) {
    return this.snappayService.adminReconcilePayment(paymentId);
  }

  //==============================================================
  // Digipay — عملیات ادمین (تحویل / عودت / استعلام)
  //==============================================================

  /**
   * اعلام تحویل خرید اعتباری/BNPL یک سفارش به دیجی‌پی
   * (`purchases/deliver` — بند ۱۰). برای خریدهای IPG/Wallet بی‌اثر است.
   */
  @Post('digipay/admin/orders/:orderId/deliver')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async digipayAdminDeliver(@Param('orderId', ParseIntPipe) orderId: number) {
    return this.digipayService.deliverOrder(orderId);
  }

  /**
   * عودت وجه پرداخت‌های دیجی‌پی یک سفارش (`refunds` — بند ۱۱).
   * بدنه: { "confirm": true, "amount": 100000, "reason": "..." }
   * اگر `amount` (تومان) داده نشود، کل ماندهٔ قابل عودت برمی‌گردد.
   */
  @Post('digipay/admin/orders/:orderId/refund')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async digipayAdminRefund(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: DigipayAdminRefundDto,
  ) {
    if (dto.confirm !== true) {
      throw new BadRequestException(
        'برای ثبت عودت باید confirm=true ارسال شود',
      );
    }

    return this.digipayService.refundOrder(orderId, {
      amount: dto.amount,
      reason: dto.reason,
    });
  }

  /** استعلام وضعیت نهایی یک درخواست عودت دیجی‌پی (Refund Inquiry — بند ۱۲) */
  @Post('digipay/admin/refunds/:refundId/inquiry')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async digipayAdminRefundInquiry(
    @Param('refundId', ParseIntPipe) refundId: number,
  ) {
    const refund = await this.digipayService.findRefundById(refundId);

    return this.digipayService.inquireRefund(refund);
  }

  /** فهرست درخواست‌های عودت دیجی‌پی (اختیاری برای یک پرداخت خاص) */
  @Get('digipay/admin/refunds')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async digipayAdminRefunds(@Query('paymentId') paymentId?: string) {
    const parsed = Number(paymentId);

    return this.digipayService.listRefunds(
      Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
    );
  }

  /** تلاش مجدد برای verify یک پرداخت دیجی‌پی (همان مسیر کرون) */
  @Post('digipay/admin/payments/:paymentId/reconcile')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async digipayAdminReconcile(
    @Param('paymentId', ParseIntPipe) paymentId: number,
  ) {
    return this.digipayService.reconcilePaymentById(paymentId);
  }
}
