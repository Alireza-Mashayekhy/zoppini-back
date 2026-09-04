import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as soap from 'soap';
import { OrdersService } from 'src/order/order.service';
import { LessThan, Repository } from 'typeorm';

import {
  Payment,
  PaymentGateway,
  PaymentStatus,
} from '../entities/payment.entity';
import {
  describeMellatResCode,
  isMellatInconclusive,
  isMellatSettleAccepted,
  isMellatVerifyAccepted,
  MELLAT_REVERSED,
  MELLAT_VERIFY_WINDOW_MINUTES,
  normalizeMellatResCode,
  parseMellatPayResponse,
} from '../utils/mellat.constants';
import { PaymentGuardService } from './payment-guard.service';

@Injectable()
export class MellatPaymentService {
  private readonly logger = new Logger(MellatPaymentService.name);

  private wsClient: any;

  private lastGatewayOrderId = 0;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
    private ordersService: OrdersService,

    private readonly paymentGuard: PaymentGuardService,
  ) {}

  // === اصلاح متد getClient ===
  private getCredentials(): {
    terminalId: number;
    userName: string;
    userPassword: string;
  } {
    const terminalId = this.configService.get<string>('MELLAT_TERMINAL_ID');
    const userName = this.configService.get<string>('MELLAT_USERNAME');
    const userPassword = this.configService.get<string>('MELLAT_PASSWORD');

    if (!terminalId?.trim()) {
      throw new BadRequestException('MELLAT_TERMINAL_ID تنظیم نشده است');
    }

    if (!userName?.trim()) {
      throw new BadRequestException('MELLAT_USERNAME تنظیم نشده است');
    }

    if (!userPassword?.trim()) {
      throw new BadRequestException('MELLAT_PASSWORD تنظیم نشده است');
    }

    return {
      terminalId: Number(terminalId),
      userName,
      userPassword,
    };
  }

  private getWsdlUrl(): string {
    const wsdlUrl = this.configService.get<string>('MELLAT_WS_URL');

    if (!wsdlUrl?.trim()) {
      throw new BadRequestException('MELLAT_WS_URL تنظیم نشده است');
    }

    return wsdlUrl.trim();
  }

  private getPayUrl(): string {
    const payUrl = this.configService.get<string>('MELLAT_PAY_URL');

    if (!payUrl?.trim()) {
      throw new BadRequestException('MELLAT_PAY_URL تنظیم نشده است');
    }

    return payUrl.trim();
  }

  /**
   * آدرس بازگشت از درگاه.
   * طبق مستند این آدرس «الزاماً می‌بایست در دامنهٔ سایت ثبت‌شده برای پذیرنده
   * قرار داشته باشد» و بهتر است Domain باشد نه IP؛ در غیر این صورت کد ۶۲
   * برگردانده می‌شود.
   */
  private getCallbackUrl(): string {
    const explicit = this.configService.get<string>(
      'MELLAT_PAYMENT_CALLBACK_URL',
    );

    if (explicit?.trim()) {
      return explicit.trim();
    }

    const appUrl = this.configService.get<string>('APP_URL');

    if (!appUrl?.trim()) {
      throw new BadRequestException(
        'MELLAT_PAYMENT_CALLBACK_URL یا APP_URL تنظیم نشده است',
      );
    }
    return `${appUrl.trim().replace(/\/+$/, '')}/api/payment/callback/mellat`;
  }

  async getClient() {
    if (this.wsClient) return this.wsClient;

    this.wsClient = await soap.createClientAsync(this.getWsdlUrl());
    return this.wsClient;
  }

  private async callBp<T = string>(
    methodName:
      | 'bpPayRequestAsync'
      | 'bpVerifyRequestAsync'
      | 'bpSettleRequestAsync'
      | 'bpInquiryRequestAsync'
      | 'bpReversalRequestAsync',
    payload: Record<string, unknown>,
  ): Promise<T> {
    try {
      const client = await this.getClient();
      const result = await client[methodName](payload);

      return (result?.[0]?.return ?? result?.[0]) as T;
    } catch (error) {
      this.wsClient = null;

      throw error;
    }
  }

  private nextGatewayOrderId(): string {
    let candidate = Date.now() * 1000 + Math.floor(Math.random() * 1000);

    if (candidate <= this.lastGatewayOrderId) {
      candidate = this.lastGatewayOrderId + 1;
    }

    this.lastGatewayOrderId = candidate;

    return String(candidate);
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

    const { terminalId, userName, userPassword } = this.getCredentials();
    const callbackUrl = this.getCallbackUrl();
    const payUrl = this.getPayUrl();

    const amount = Math.round(Number(order.finalPrice) * 10);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('مبلغ سفارش نامعتبر است');
    }

    const gatewayOrderId = this.nextGatewayOrderId();

    // تاریخ/ساعت باید به وقت تهران باشد نه وقت سرور (کد ۳۵ = تاریخ نامعتبر)
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
      terminalId,
      userName,
      userPassword,
      orderId: gatewayOrderId,
      amount,
      localDate,
      localTime,
      additionalData: `orderId:${orderId}`,
      callBackUrl: callbackUrl,
      payerId: this.configService.get<string>('MELLAT_PAYER_ID')?.trim() || '0',
    };

    let response: string;

    try {
      response = await this.callBp<string>('bpPayRequestAsync', payload);
    } catch (error) {
      this.logger.error(
        `❌ خطا در ارتباط با درگاه ملت (bpPayRequest) برای سفارش ${orderId}`,
        error instanceof Error ? error.stack : String(error),
      );

      throw new BadRequestException('خطا در ارتباط با درگاه پرداخت');
    }

    const { resCode, refId } = parseMellatPayResponse(response);

    if (resCode !== '0') {
      this.logger.error(
        `❌ bpPayRequest برای سفارش ${orderId} رد شد: ${describeMellatResCode(resCode)}`,
      );

      throw new BadRequestException(
        `خطا در درخواست پرداخت: ${describeMellatResCode(resCode)}`,
      );
    }

    if (!refId) {
      this.logger.error(
        `❌ bpPayRequest برای سفارش ${orderId} موفق بود ولی RefId برنگشت: ${response}`,
      );

      throw new BadRequestException('شناسهٔ پرداخت از درگاه دریافت نشد');
    }

    const payment = this.paymentRepo.create({
      orderId,
      refId,
      amount,
      gateway: PaymentGateway.MELLAT,
      status: PaymentStatus.PENDING,
      resCode,
      // همان orderId مرحلهٔ Sale که طبق مستند به SaleOrderId تبدیل می‌شود
      saleOrderId: gatewayOrderId,
      gatewayResponse: { bpPayRequest: response },
    });
    await this.paymentRepo.save(payment);

    /*
     * هدایت کاربر (Redirect): RefId باید با متد POST به آدرس صفحهٔ پرداخت
     * ارسال شود. دو نکتهٔ مستند که سمت فرانت باید رعایت شود:
     *   ۱. هدر Referer اجباری است و باید دامنهٔ ثبت‌شدهٔ پذیرنده باشد
     *   ۲. RefId دقیقاً و بدون تغییر (Case Sensitive) ارسال شود
     */
    return { refId, payUrl };
  }

  /**
   * تبدیل مقدار شناسه‌های عددی درگاه به رشتهٔ رقم‌ها.
   *
   * saleOrderId و saleReferenceId ملت اعداد ۱۶ رقمی و بزرگ‌ترند و از حد
   * Number.MAX_SAFE_INTEGER (۹۰۰۷۱۹۹۲۵۴۷۴۰۹۹۱) عبور می‌کنند؛ اگر با
   * Number() خوانده شوند رقم‌های انتهایی خراب می‌شود و bpVerifyRequest /
   * bpSettleRequest شکست می‌خورند. SOAP این مقادیر را به‌صورت متنی می‌فرستد
   * پس رشتهٔ دقیق، ورودی درست‌تری است.
   */
  private toGatewayNumber(value?: number | string | null): string {
    if (value === undefined || value === null) {
      return '';
    }

    const text = String(value).trim();

    return /^\d+$/.test(text) ? text : '';
  }

  // src/payment/mellat-payment.service.ts (بخش verifyPayment)

  async verifyPayment(
    refId: string,
    callbackData?: {
      resCode?: string;
      saleOrderId?: number | string;
      saleReferenceId?: number | string;
      cardHolderPan?: string;
      finalAmount?: number | string;
      creditCardSaleResponseDetail?: string;
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

    await this.storeCallbackData(payment, callbackData);

    if (callbackData?.resCode) {
      this.logger.log(
        `callback ملت برای پرداخت ${payment.id}: ${describeMellatResCode(callbackData.resCode)}`,
      );
    }

    const callbackSaleOrderId = this.toGatewayNumber(callbackData?.saleOrderId);

    if (
      callbackSaleOrderId &&
      payment.saleOrderId &&
      callbackSaleOrderId !== this.toGatewayNumber(payment.saleOrderId)
    ) {
      this.logger.error(
        `❌ پرداخت ${payment.id}: SaleOrderId دریافتی در callback (${callbackSaleOrderId}) ` +
          `با مقدار ارسالی در bpPayRequest (${payment.saleOrderId}) همخوانی ندارد. ` +
          'تراکنش نامعتبر قلمداد شد و bpVerifyRequest فراخوانی نمی‌شود.',
      );

      payment.status = PaymentStatus.FAILED;
      payment.resCode = 'INVALID_CALLBACK';
      await this.paymentRepo.save(payment);

      return {
        success: false,
        message: 'تراکنش نامعتبر است؛ با پشتیبانی تماس بگیرید',
        orderId: payment.orderId,
      };
    }

    if (payment.status === PaymentStatus.VERIFIED) {
      return this.settlePayment(payment);
    }

    const gatewayOrderId = this.toGatewayNumber(
      payment.saleOrderId ?? callbackData?.saleOrderId,
    );
    const saleReferenceId = this.toGatewayNumber(
      payment.saleReferenceId ?? callbackData?.saleReferenceId,
    );

    if (!gatewayOrderId || !saleReferenceId) {
      this.logger.error(
        `payment ${payment.id}: اطلاعات لازم برای verify ناقص است ` +
          `(saleOrderId=${gatewayOrderId || 'خالی'}, saleReferenceId=${saleReferenceId || 'خالی'})`,
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
      ...this.getCredentials(),
      orderId: gatewayOrderId,
      saleOrderId: gatewayOrderId,
      saleReferenceId,
    };

    let verifyResCode: string;

    try {
      verifyResCode = normalizeMellatResCode(
        await this.callBp('bpVerifyRequestAsync', bpPayload),
      );
    } catch (error) {
      /*
       * پاسخی از bpVerifyRequest نگرفتیم → طبق بند bpInquiryRequest مستند،
       * وضعیت با استعلام روشن می‌شود و در صورت بی‌نتیجه ماندن، برگشت وجه.
       */
      this.logger.error(
        `❌ عدم دریافت پاسخ از bpVerifyRequest برای پرداخت ${payment.id}`,
        error instanceof Error ? error.stack : String(error),
      );

      return this.resolveUncertainStatus(payment, 'پاسخی دریافت نشد');
    }

    this.logger.log(
      `bpVerifyRequest برای پرداخت ${payment.id}: ${describeMellatResCode(verifyResCode)}`,
    );

    if (isMellatVerifyAccepted(verifyResCode)) {
      payment.resCode = verifyResCode;
      await this.paymentRepo.save(payment);

      return this.settlePayment(payment);
    }

    if (isMellatInconclusive(verifyResCode)) {
      return this.resolveUncertainStatus(payment, verifyResCode);
    }

    // شکست قطعی (مثلاً ۱۷ = انصراف کاربر یا ۴۸ = تراکنش Reverse شده است)
    return this.markFailed(payment, verifyResCode, 'تأیید ناموفق');
  }

  /**
   * bpSettleRequest — درخواست واریز وجه.
   *
   * اگر واریز قطعی نشود، پرداخت در وضعیت VERIFIED می‌ماند: وجه تأیید شده و
   * کسر شده است، پس سفارش نباید لغو شود. طبق مستند، تراکنش‌های موفقی که
   * ۱۸۰ دقیقه از آن‌ها گذشته و درخواست ریورس یا واریز برایشان ارسال نشده،
   * توسط شرکت به پرداخت «به نیابت از پذیرنده» واریز می‌شوند.
   */
  async settlePayment(payment: Payment): Promise<{
    success: boolean;
    message: string;
    orderId?: number;
  }> {
    const gatewayOrderId = this.toGatewayNumber(payment.saleOrderId);
    const saleReferenceId = this.toGatewayNumber(payment.saleReferenceId);

    if (!gatewayOrderId || !saleReferenceId) {
      this.logger.error(
        `payment ${payment.id}: اطلاعات لازم برای settle ناقص است`,
      );

      return {
        success: false,
        message: 'اطلاعات تراکنش ناقص است؛ با پشتیبانی تماس بگیرید',
        orderId: payment.orderId,
      };
    }

    const bpPayload = {
      ...this.getCredentials(),
      orderId: gatewayOrderId,
      saleOrderId: gatewayOrderId,
      saleReferenceId,
    };

    let settleResCode: string;

    try {
      settleResCode = normalizeMellatResCode(
        await this.callBp('bpSettleRequestAsync', bpPayload),
      );
    } catch (error) {
      this.logger.error(
        `❌ عدم دریافت پاسخ از bpSettleRequest برای پرداخت ${payment.id}. ` +
          'وضعیت روی VERIFIED می‌ماند و بعداً دوباره تلاش می‌شود.',
        error instanceof Error ? error.stack : String(error),
      );

      await this.markVerified(payment, 'پاسخی دریافت نشد');

      return {
        success: true,
        message: 'پرداخت تأیید شد؛ واریز در حال پیگیری است',
        orderId: payment.orderId,
      };
    }

    this.logger.log(
      `bpSettleRequest برای پرداخت ${payment.id}: ${describeMellatResCode(settleResCode)}`,
    );

    if (!isMellatSettleAccepted(settleResCode)) {
      /*
       * تأیید (verify) موفق بوده، پس وجه کسر شده است؛ لغو کردن سفارش در این
       * حالت یعنی از دست دادن کالا بدون بازگشت پول. وضعیت VERIFIED ثبت می‌شود
       * تا واریز دوباره تلاش شود.
       */
      await this.markVerified(payment, settleResCode);

      return {
        success: true,
        message: 'پرداخت تأیید شد؛ واریز در حال پیگیری است',
        orderId: payment.orderId,
      };
    }

    payment.status = PaymentStatus.SUCCESS;
    payment.resCode = settleResCode;
    await this.paymentRepo.save(payment);

    return this.confirmOrder(payment);
  }

  // =========================================================
  // bpInquiryRequest — استعلام
  // =========================================================

  /**
   * استعلام وضعیت تراکنش؛ زمانی کاربرد دارد که از نتیجهٔ bpVerifyRequest
   * مطلع نشویم (بند bpInquiryRequest مستند).
   * خروجی: کد پاسخ یا null اگر پاسخی نگرفتیم.
   */
  async inquiryPayment(payment: Payment): Promise<string | null> {
    const gatewayOrderId = this.toGatewayNumber(payment.saleOrderId);
    const saleReferenceId = this.toGatewayNumber(payment.saleReferenceId);

    if (!gatewayOrderId || !saleReferenceId) {
      return null;
    }

    try {
      const resCode = normalizeMellatResCode(
        await this.callBp('bpInquiryRequestAsync', {
          ...this.getCredentials(),
          orderId: gatewayOrderId,
          saleOrderId: gatewayOrderId,
          saleReferenceId,
        }),
      );

      this.logger.log(
        `bpInquiryRequest برای پرداخت ${payment.id}: ${describeMellatResCode(resCode)}`,
      );

      return resCode;
    } catch (error) {
      this.logger.error(
        `❌ bpInquiryRequest هم برای پرداخت ${payment.id} پاسخ نداد.`,
        error instanceof Error ? error.stack : String(error),
      );

      return null;
    }
  }

  // =========================================================
  // bpReversalRequest — برگشت وجه
  // =========================================================

  /**
   * برگشت وجه؛ وقتی وضعیت پرداخت روشن نیست و استعلام هم نتیجه نداده است.
   *
   * مستند: «این متد می‌بایست پس از فراخوانی متد bpVerifyRequest فراخوانده شود
   * و حداکثر زمان اعلام reverse برای هر تراکنش ۳ ساعت پس از انجام عملیات Verify
   * می‌باشد.» و «حداکثر زمان برگشت وجه ... تا پایان روز جاری به شرط آن که
   * درخواست واریز وجه داده نشده باشد.»
   *
   * ⚠️ پس از ارسال درخواست واریز (settle) نباید reversal فرستاد؛ به همین دلیل
   * فقط از مسیر verify ناموفق/نامشخص فراخوانی می‌شود.
   */
  async reversePayment(payment: Payment): Promise<string | null> {
    const gatewayOrderId = this.toGatewayNumber(payment.saleOrderId);
    const saleReferenceId = this.toGatewayNumber(payment.saleReferenceId);

    if (!gatewayOrderId || !saleReferenceId) {
      return null;
    }

    try {
      const resCode = normalizeMellatResCode(
        await this.callBp('bpReversalRequestAsync', {
          ...this.getCredentials(),
          orderId: gatewayOrderId,
          saleOrderId: gatewayOrderId,
          saleReferenceId,
        }),
      );

      this.logger.log(
        `bpReversalRequest برای پرداخت ${payment.id}: ${describeMellatResCode(resCode)}`,
      );

      return resCode;
    } catch (error) {
      this.logger.error(
        `❌ bpReversalRequest برای پرداخت ${payment.id} پاسخ نداد.`,
        error instanceof Error ? error.stack : String(error),
      );

      return null;
    }
  }

  /**
   * روشن کردن وضعیت تراکنشی که نتیجهٔ verify آن نامشخص است:
   *   ۱) استعلام (bpInquiryRequest)
   *   ۲) اگر باز هم روشن نشد → برگشت وجه (bpReversalRequest) تا از کسر نشدن
   *      مبلغ از کارت مشتری مطمئن شویم و کالا/خدمت ارائه نشود.
   */
  private async resolveUncertainStatus(
    payment: Payment,
    verifyResCode: string,
  ): Promise<{ success: boolean; message: string; orderId?: number }> {
    const inquiryResCode = await this.inquiryPayment(payment);

    if (inquiryResCode !== null) {
      if (isMellatVerifyAccepted(inquiryResCode)) {
        // تراکنش سمت بانک موفق است → واریز
        payment.resCode = inquiryResCode;
        await this.paymentRepo.save(payment);

        return this.settlePayment(payment);
      }

      if (!isMellatInconclusive(inquiryResCode)) {
        // شکست قطعی از نگاه بانک (مثلاً ۴۲ یا ۴۸)
        return this.markFailed(payment, inquiryResCode, 'استعلام ناموفق');
      }
    }

    /*
     * هنوز نمی‌دانیم پول کسر شده یا نه → طبق مستند از ارائهٔ کالا/خدمت
     * خودداری و درخواست برگشت وجه ارسال می‌کنیم.
     */
    this.logger.warn(
      `⚠️ وضعیت پرداخت ${payment.id} روشن نشد (verify: ${describeMellatResCode(verifyResCode)}, ` +
        `inquiry: ${inquiryResCode === null ? 'بدون پاسخ' : describeMellatResCode(inquiryResCode)}). ` +
        'ارسال bpReversalRequest برای اطمینان از عدم کسر وجه.',
    );

    const reversalResCode = await this.reversePayment(payment);

    if (reversalResCode === null) {
      // حتی برگشت وجه هم پاسخ نداد → وضعیت PENDING می‌ماند تا دستی بررسی شود
      payment.resCode = verifyResCode;
      payment.gatewayResponse = {
        ...(payment.gatewayResponse ?? {}),
        uncertain: { verifyResCode, inquiryResCode },
      };
      await this.paymentRepo.save(payment);

      return {
        success: false,
        message: 'خطا در تأیید پرداخت؛ تراکنش در حال بررسی است',
        orderId: payment.orderId,
      };
    }

    if (isMellatInconclusive(reversalResCode)) {
      payment.resCode = verifyResCode;
      payment.gatewayResponse = {
        ...(payment.gatewayResponse ?? {}),
        uncertain: { verifyResCode, inquiryResCode, reversalResCode },
      };
      await this.paymentRepo.save(payment);

      return {
        success: false,
        message: 'خطا در تأیید پرداخت؛ تراکنش در حال بررسی است',
        orderId: payment.orderId,
      };
    }

    // برگشت وجه انجام شد (۰) یا تراکنش پیش‌تر reverse شده بود (۴۸)
    return this.markFailed(payment, MELLAT_REVERSED, 'برگشت وجه');
  }

  // =========================================================
  // مشترک
  // =========================================================

  /** ثبت اطلاعات callback (بند ۲-۴ مستند) */
  private async storeCallbackData(
    payment: Payment,
    callbackData?: {
      resCode?: string;
      saleOrderId?: number | string;
      saleReferenceId?: number | string;
      cardHolderPan?: string;
      finalAmount?: number | string;
      creditCardSaleResponseDetail?: string;
    },
  ): Promise<void> {
    if (!callbackData) {
      return;
    }

    const callback: Record<string, string> = {};

    for (const [key, value] of Object.entries(callbackData)) {
      if (value !== undefined && value !== null && value !== '') {
        callback[key] = String(value);
      }
    }

    if (!Object.keys(callback).length) {
      return;
    }

    /*
     * FinalAmount = «مبلغ نهایی کسر شده از دارنده در طرح تخفیف آنلاین».
     * اگر با مبلغ ثبت‌شده یکی نباشد، باید دستی بررسی شود (طرح تخفیف آنلاین
     * می‌تواند مبلغ کسرشده را کم کند، پس سفارش را مسدود نمی‌کنیم).
     */
    const finalAmount = Number(callback.finalAmount);

    if (
      callback.finalAmount &&
      Number.isFinite(finalAmount) &&
      finalAmount > 0 &&
      finalAmount !== Number(payment.amount)
    ) {
      this.logger.warn(
        `⚠️ پرداخت ${payment.id}: مبلغ نهایی کسرشده از دارنده (${finalAmount}) ` +
          `با مبلغ ثبت‌شده (${payment.amount}) یکی نیست.`,
      );
    }

    payment.gatewayResponse = {
      ...(payment.gatewayResponse ?? {}),
      callback,
    };

    await this.paymentRepo.save(payment);
  }

  private async markVerified(payment: Payment, resCode: string): Promise<void> {
    payment.status = PaymentStatus.VERIFIED;
    payment.resCode = normalizeMellatResCode(resCode) || payment.resCode;
    payment.gatewayResponse = {
      ...(payment.gatewayResponse ?? {}),
      verifiedAt: new Date().toISOString(),
      settlePending: describeMellatResCode(resCode),
    };

    await this.paymentRepo.save(payment);

    this.logger.warn(
      `⚠️ پرداخت ${payment.id} تأیید (verify) شد ولی واریز (settle) قطعی نشد: ` +
        `${describeMellatResCode(resCode)}. وضعیت VERIFIED ثبت شد.`,
    );
  }

  /**
   * ناموفق‌کردن قطعی پرداخت بر پایهٔ ResCode برگشتی از درگاه.
   *
   * برای حالتی است که بانک SaleReferenceId برنگردانده (مثلاً کاربر از انجام
   * تراکنش منصرف شده است — کد ۱۷) و در نتیجه چیزی برای bpVerifyRequest وجود
   * ندارد.
   */
  async rejectFromCallback(
    payment: Payment,
    resCode: string,
  ): Promise<{ success: boolean; message: string; orderId?: number }> {
    return this.markFailed(payment, resCode, 'ResCode برگشتی از درگاه');
  }

  private async markFailed(
    payment: Payment,
    resCode: string,
    reason: string,
  ): Promise<{ success: boolean; message: string; orderId?: number }> {
    const normalized = normalizeMellatResCode(resCode);

    payment.status = PaymentStatus.FAILED;
    payment.resCode = normalized || 'UNKNOWN';
    await this.paymentRepo.save(payment);

    this.logger.warn(
      `تراکنش ملت ناموفق — پرداخت ${payment.id} (${reason}): ${describeMellatResCode(normalized)}`,
    );

    await this.failOrder(payment.orderId);

    return {
      success: false,
      message: `پرداخت ناموفق: ${describeMellatResCode(normalized)}`,
      orderId: payment.orderId,
    };
  }

  /** لغو سفارش به دلیل ناموفق بودن پرداخت */
  private async failOrder(orderId: number): Promise<void> {
    try {
      await this.ordersService.failOrderPayment(orderId);
    } catch (error) {
      // مثلاً سفارش پیش‌تر لغو/تأیید شده است
      this.logger.warn(
        `لغو سفارش ${orderId} پس از پرداخت ناموفق ممکن نشد: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * تأیید نهایی سفارش (کاهش موجودی + خالی کردن سبد).
   * اگر خطا بدهد، پول گرفته شده است؛ پس پرداخت SUCCESS می‌ماند و سفارش لغو
   * نمی‌شود تا دستی بررسی/اصلاح شود.
   */
  private async confirmOrder(payment: Payment): Promise<{
    success: boolean;
    message: string;
    orderId?: number;
  }> {
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
  }

  // =========================================================
  // همسان‌سازی پرداخت‌های بلاتکلیف (برای زمان‌بند)
  // =========================================================

  /**
   * پرداخت‌های بلاتکلیف ملت را به نتیجه می‌رساند.
   *
   * - VERIFIED: واریز ناتمام مانده → تلاش دوبارهٔ bpSettleRequest
   * - PENDING با saleReferenceId و سن کمتر از مهلت ۲۰ دقیقه‌ای: verify دوباره
   * - PENDING با saleReferenceId و سن بیشتر از مهلت: دروازه پرداخت خودش
   *   Autoreversal فرستاده و تراکنش ناموفق محسوب می‌شود → ثبت FAILED
   *
   * سفارش در حالت آخر لغو نمی‌شود تا کاربر بتواند دوباره پرداخت کند.
   */
  async reconcilePendingPayments(limit = 25): Promise<void> {
    const now = Date.now();

    // پرداخت‌های تأییدشده با واریزِ ناتمام → تلاش دوبارهٔ settle
    const verifiedPayments = await this.paymentRepo.find({
      where: {
        gateway: PaymentGateway.MELLAT,
        status: PaymentStatus.VERIFIED,
        createdAt: LessThan(new Date(now - 60_000)),
      },
      take: limit,
      order: { id: 'ASC' },
    });

    for (const payment of verifiedPayments) {
      await this.settlePayment(payment);
    }

    /*
     * پرداخت‌های بلاتکلیف. دو دقیقه صبر می‌کنیم تا با callback در جریان
     * تداخل نکنیم؛ verify/settle در این درگاه idempotent هستند
     * (کد ۴۳ = قبلاً verify شده، ۴۵ = قبلاً settle شده).
     */
    const pendingPayments = await this.paymentRepo.find({
      where: {
        gateway: PaymentGateway.MELLAT,
        status: PaymentStatus.PENDING,
        createdAt: LessThan(new Date(now - 2 * 60_000)),
      },
      take: limit,
      order: { id: 'ASC' },
    });

    for (const payment of pendingPayments) {
      if (!this.toGatewayNumber(payment.saleReferenceId)) {
        // بدون SaleReferenceId (یعنی callback نرسیده) چیزی برای verify نیست؛
        // درخواست پرداخت بعدی، این رکورد را باطل می‌کند.
        continue;
      }

      const ageMinutes = (now - new Date(payment.createdAt).getTime()) / 60_000;

      if (ageMinutes <= MELLAT_VERIFY_WINDOW_MINUTES) {
        // هنوز داخل مهلت ۲۰ دقیقه‌ای هستیم → شانس نجات تراکنش
        this.logger.log(
          `تلاش دوباره برای verify پرداخت بلاتکلیف ${payment.id} (سفارش ${payment.orderId})`,
        );

        await this.verifyPayment(payment.refId);

        continue;
      }

      /*
       * مهلت ۲۰ دقیقه‌ای verify گذشته است؛ طبق مستند دروازه پرداخت بازگشت
       * خودکار وجه (Autoreversal) فرستاده و این تراکنش ناموفق محسوب شده و
       * وجه به حساب دارندهٔ کارت برگشت داده می‌شود.
       */
      this.logger.warn(
        `پرداخت ${payment.id} (سفارش ${payment.orderId}) خارج از مهلت ${MELLAT_VERIFY_WINDOW_MINUTES} دقیقه‌ای verify ماند؛ ` +
          'طبق مستند Autoreversal انجام شده و تراکنش ناموفق است.',
      );

      payment.status = PaymentStatus.FAILED;
      payment.resCode = MELLAT_REVERSED;
      this.mergeGatewayResponse(
        payment,
        'autoReversal',
        new Date().toISOString(),
      );
      await this.paymentRepo.save(payment);
    }
  }

  /** ادغام بخشی از پاسخ درگاه در gatewayResponse بدون از دست دادن بخش‌های قبلی */
  private mergeGatewayResponse(
    payment: Payment,
    key: string,
    value: unknown,
  ): void {
    const current = payment.gatewayResponse;
    const base =
      current && typeof current === 'object' && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {};

    payment.gatewayResponse = { ...base, [key]: value };
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
