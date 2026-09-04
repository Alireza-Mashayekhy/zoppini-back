import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderStatus } from 'src/order/entities/order.entity';
import { OrdersService } from 'src/order/order.service';
import { LessThan, Repository } from 'typeorm';

import {
  Payment,
  PaymentGateway,
  PaymentStatus,
} from '../entities/payment.entity';
import {
  describeTaraResult,
  TARA_AUTO_REFUND_MINUTES,
  TARA_RECONCILE_AFTER_MINUTES,
  TARA_SUCCESS_RESULT,
  TaraUnit,
} from '../utils/tara.constants';
import { PaymentGuardService } from './payment-guard.service';
import { TaraAuthService } from './tara-auth.service';

/**
 * پیاده‌سازی درگاه تارا (IPG) بر پایهٔ
 * «مستند سرویس‌های خرید اینترنتی تارا (بر پایه وب)»
 *
 * فرایند طبق بخش ۲ مستند:
 *   1) getToken  2) هدایت کاربر به ipgPurchase  3) پرداخت
 *   4) callback  5) purchaseVerify  6) purchaseInquiry (در صورت بی‌پاسخ بودن verify)
 */
@Injectable()
export class TaraPaymentService {
  private readonly logger = new Logger(TaraPaymentService.name);

  constructor(
    private configService: ConfigService,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
    private ordersService: OrdersService,
    private authService: TaraAuthService,

    private readonly paymentGuard: PaymentGuardService,
  ) {}

  // =========================================================
  // پیکربندی
  // =========================================================

  private getApiUrl(): string {
    const apiUrl = this.configService.get<string>('TARA_API_URL');

    if (!apiUrl) {
      throw new BadRequestException('TARA_API_URL تنظیم نشده است');
    }

    return apiUrl.replace(/\/+$/, '');
  }

  private getUsername(): string {
    const username = this.configService.get<string>('TARA_USERNAME');

    if (!username) {
      throw new BadRequestException('TARA_USERNAME تنظیم نشده است');
    }

    return username;
  }

  /**
   * آدرس بازگشت از درگاه.
   * اگر TARA_PAYMENT_CALLBACK_URL ست نشده باشد، از APP_URL ساخته می‌شود
   * (وگرنه callBackUrl خالی می‌رفت و خطای «92 = فرمت آدرس برگشتی صحیح نمیباشد»
   * یا «87/88» می‌گرفتیم).
   */
  private getCallbackUrl(): string {
    const explicit = this.configService.get<string>(
      'TARA_PAYMENT_CALLBACK_URL',
    );

    if (explicit?.trim()) {
      return explicit.trim();
    }

    const appUrl = this.configService.get<string>('APP_URL');

    if (!appUrl?.trim()) {
      throw new BadRequestException(
        'TARA_PAYMENT_CALLBACK_URL یا APP_URL تنظیم نشده است',
      );
    }

    return `${appUrl.trim().replace(/\/+$/, '')}/api/payment/callback/tara`;
  }

  /**
   * شماره سرویس (serviceId) — طبق مستند از نوع long و بخشی از مدل ServiceAmount.
   * مقدار واقعی را تارا به پذیرنده می‌دهد؛ اگر ست نشود از ۱ استفاده می‌شود.
   * (خطاهای «9 = شماره سرویس نامعتبر است» و «91 = شناسه سرویس نامعتبر»)
   */
  private getServiceId(): number {
    const raw = this.configService.get<string>('TARA_SERVICE_ID');
    const parsed = Number(raw);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  /**
   * کد/عنوان گروه کالایی.
   *
   * طبق بخش ۲-۱ مستند، نگاشت گروه‌های کالایی تارا (سرویس /api/clubGroups)
   * «ضروری» است. تا زمانی که جدول نگاشت دسته‌بندی ↔ گروه تارا ساخته شود،
   * مقدار پیش‌فرض از env خوانده می‌شود.
   */
  private getMerchandiseGroup(): { group: string; groupTitle: string } {
    return {
      group: this.configService.get<string>('TARA_MERCHANDISE_GROUP') ?? '',
      groupTitle:
        this.configService.get<string>('TARA_MERCHANDISE_GROUP_TITLE') ?? '',
    };
  }

  // =========================================================
  // 1) دریافت شناسه یکتا — POST /api/getToken
  // =========================================================

  async requestPayment(
    orderId: number,
    userId: number,
    clientIp?: string,
  ): Promise<{ refId: string; payUrl: string; username: string }> {
    const order = await this.ordersService.findOneForPayment(orderId, userId);
    if (!order) {
      throw new BadRequestException('سفارش یافت نشد');
    }

    // سفارش باید PENDING باشد و درخواست پرداخت بازی (هر درگاهی) نباشد
    await this.paymentGuard.ensureOrderPayable(order);

    const accessToken = await this.authService.getAccessToken();
    const apiUrl = this.getApiUrl();
    const callbackUrl = this.getCallbackUrl();
    const username = this.getUsername();

    // مبلغ به ریال (ورودی amount در مستند از نوع string است)
    const amount = Math.round(Number(order.finalPrice) * 10);

    if (!amount || amount <= 0) {
      throw new BadRequestException('مبلغ سفارش نامعتبر است');
    }

    const { group, groupTitle } = this.getMerchandiseGroup();

    /*
     * ساخت آیتم‌های صورت‌حساب (مدل TaraInvoiceItem):
     *
     * - fee: قیمت «یک واحد» کالا از نوع long → قیمت فریزشدهٔ زمان خرید
     *   (OrderItem.price) و نه قیمت لحظه‌ای واریانت؛ وگرنه مبلغ فاکتور
     *   با مبلغ سفارش یکی نمی‌شود.
     *
     * - unit: طبق مستند ۵ = «عدد» (مقدار قبلی ۱ بود که یعنی کیلوگرم!)
     */
    const taraInvoiceItemList = order.items.map(item => ({
      name: item.variant?.product?.title || 'محصول',
      code: item.variant?.product?.productCode || '',
      count: Number(item.quantity),
      unit: TaraUnit.PIECE,
      fee: Math.round(Number(item.price) * 10),
      group,
      groupTitle,
      data: '',
    }));

    /*
     * کنترل داخلی: جمع آیتم‌ها باید با مبلغ کل بخواند.
     * هزینهٔ ارسال و تخفیف در آیتم‌ها نیستند، پس اگر اختلاف داشت
     * لاگ می‌زنیم تا در صورت دریافت خطای «11 = مبالغ یکسان نیست»
     * علتش معلوم باشد.
     */
    const itemsTotal = taraInvoiceItemList.reduce(
      (sum, item) => sum + item.fee * item.count,
      0,
    );

    if (itemsTotal !== amount) {
      this.logger.warn(
        `سفارش ${orderId}: جمع آیتم‌های فاکتور (${itemsTotal}) با مبلغ ارسالی به تارا (${amount}) برابر نیست ` +
          `(shippingCost=${order.shippingCost}, discount=${order.discount}). ` +
          'در صورت دریافت result=11 باید هزینهٔ ارسال/تخفیف هم در taraInvoiceItemList لحاظ شود.',
      );
    }

    const payload = {
      // فیلد اجباری؛ باید IP واقعی کاربر باشد (خطاهای 1 و 88)
      ip: clientIp || '',
      serviceAmountList: [
        {
          serviceId: this.getServiceId(),
          amount,
        },
      ],
      taraInvoiceItemList,
      additionalData: '',
      callBackUrl: callbackUrl,
      amount: String(amount),
      mobile: order.user?.phone || '',
      orderId: String(orderId),
      vat: 0,
    };

    if (!payload.mobile) {
      this.logger.warn(
        `سفارش ${orderId}: شماره موبایل کاربر خالی است ولی فیلد mobile در getToken اجباری است.`,
      );
    }

    try {
      const response = await fetch(`${apiUrl}/api/getToken`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await this.parseJsonResponse(response, 'getToken');

      if (String(data?.result) !== TARA_SUCCESS_RESULT) {
        this.logger.error(
          `❌ getToken ناموفق برای سفارش ${orderId}: ${describeTaraResult(data?.result)} ` +
            `- ${data?.description || ''}`,
        );

        throw new BadRequestException(
          data?.description || 'خطا در دریافت توکن تارا',
        );
      }

      const token = data?.token;

      if (!token) {
        throw new BadRequestException('توکنی از تارا دریافت نشد');
      }

      // ذخیره پرداخت
      const payment = this.paymentRepo.create({
        orderId,
        refId: token,
        amount,
        gateway: PaymentGateway.TARA,
        status: PaymentStatus.PENDING,
        resCode: String(data.result),
        /*
         * IP کاربر در زمان getToken ذخیره می‌شود تا در مراحل بعد
         * (purchaseVerify / purchaseInquiry) هم همان IP ارسال شود؛ فیلد ip
         * در همهٔ این سرویس‌ها اجباری است و در فراخوانی‌های بدون کاربر
         * (مثل زمان‌بند) به IP دیگری دسترسی نداریم.
         */
        gatewayResponse: {
          getToken: data,
          clientIp: payload.ip,
        },
      });
      await this.paymentRepo.save(payment);

      /*
       * آدرس هدایت کاربر به صفحه پرداخت (بند ۲-۲ مستند):
       * یک فرم HTML با Content-Type=form-data و دو فیلد username و token
       * باید به این آدرس POST شود؛ به همین دلیل username هم برگردانده می‌شود
       * تا فرانت مجبور به هاردکد کردن آن نباشد.
       */
      const payUrl = `${apiUrl}/api/ipgPurchase`;

      return { refId: token, payUrl, username };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `❌ خطا در ارتباط با تارا (getToken) برای سفارش ${orderId}`,
        error instanceof Error ? error.stack : String(error),
      );

      throw new BadRequestException('خطا در ارتباط با درگاه تارا');
    }
  }

  // =========================================================
  // 5) تایید خرید — POST /api/purchaseVerify
  // =========================================================

  async verifyPayment(
    token: string,
    clientIp?: string,
  ): Promise<{ success: boolean; message: string; orderId?: number }> {
    const payment = await this.paymentRepo.findOne({
      where: { refId: token, gateway: PaymentGateway.TARA },
    });
    if (!payment) {
      throw new NotFoundException('تراکنش یافت نشد');
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      return {
        success: true,
        message: 'پرداخت قبلاً تأیید شده است',
        orderId: payment.orderId,
      };
    }

    const accessToken = await this.authService.getAccessToken();
    const apiUrl = this.getApiUrl();
    const payerIp = clientIp || this.getStoredClientIp(payment);

    let data: any;

    try {
      const response = await fetch(`${apiUrl}/api/purchaseVerify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          ip: payerIp,
          token,
        }),
      });

      data = await this.parseJsonResponse(response, 'purchaseVerify');
    } catch (error) {
      /*
       * بند ۴-۲ و مرحلهٔ ۶ فرایند در مستند:
       * «در صورت عدم دریافت پاسخ از سرویس تایید خرید (verify)، پذیرنده می‌تواند
       *  با فراخوانی سرویس استعلام، از آخرین وضعیت خرید مطلع شود.»
       *
       * پس قبل از هر تصمیمی، یک‌بار استعلام می‌گیریم.
       */
      this.logger.error(
        `❌ عدم دریافت پاسخ از purchaseVerify برای پرداخت ${payment.id}; تلاش برای استعلام (purchaseInquiry)`,
        error instanceof Error ? error.stack : String(error),
      );

      const inquiryResult = await this.finalizeFromInquiry(payment, payerIp);

      if (inquiryResult) {
        return inquiryResult;
      }

      // وضعیت واقعی تراکنش هنوز معلوم نیست → PENDING می‌ماند
      return {
        success: false,
        message: 'خطا در تأیید پرداخت؛ تراکنش در حال بررسی است',
        orderId: payment.orderId,
      };
    }

    if (String(data?.result) !== TARA_SUCCESS_RESULT) {
      this.logger.warn(
        `⚠️ purchaseVerify ناموفق برای پرداخت ${payment.id}: ${describeTaraResult(data?.result)} ` +
          `- ${data?.description || ''}`,
      );

      payment.status = PaymentStatus.FAILED;
      payment.resCode = String(data?.result ?? '');
      this.mergeGatewayResponse(payment, 'purchaseVerify', data);
      await this.paymentRepo.save(payment);

      await this.ordersService.failOrderPayment(payment.orderId);

      return {
        success: false,
        message: data?.description || 'خطا در تأیید پرداخت',
        orderId: payment.orderId,
      };
    }

    /*
     * کنترل مبلغ: خروجی purchaseVerify شامل amount (string) است.
     * اگر تارا مبلغی برگرداند که با مبلغ ثبت‌شده یکی نبود، سفارش را تأیید
     * نمی‌کنیم (جلوگیری از دستکاری مبلغ).
     */
    const verifiedAmount = Number(data?.amount);

    if (Number.isFinite(verifiedAmount) && verifiedAmount > 0) {
      if (verifiedAmount !== Number(payment.amount)) {
        this.logger.error(
          `❌ پرداخت ${payment.id}: مبلغ تأییدشده از تارا (${verifiedAmount}) ` +
            `با مبلغ ثبت‌شده (${payment.amount}) یکی نیست. سفارش تأیید نمی‌شود.`,
        );

        payment.resCode = String(data?.result ?? '');
        this.mergeGatewayResponse(payment, 'purchaseVerify', data);
        await this.paymentRepo.save(payment);

        return {
          success: false,
          message: 'مبلغ تراکنش با مبلغ سفارش مطابقت ندارد',
          orderId: payment.orderId,
        };
      }
    }

    return this.markPaymentSuccess(payment, data);
  }

  // =========================================================
  // 6) استعلام خرید — POST /api/purchaseInquiry
  // =========================================================

  async inquiryPayment(token: string, clientIp?: string): Promise<any> {
    const accessToken = await this.authService.getAccessToken();
    const apiUrl = this.getApiUrl();

    const response = await fetch(`${apiUrl}/api/purchaseInquiry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        ip: clientIp || '',
        token,
      }),
    });

    return this.parseJsonResponse(response, 'purchaseInquiry');
  }

  /**
   * استعلام وضعیت و در صورت موفق بودن، نهایی‌کردن پرداخت.
   * خروجی: نتیجهٔ نهایی یا null اگر از استعلام هم نتیجه‌ای نگرفتیم.
   */
  private async finalizeFromInquiry(
    payment: Payment,
    clientIp?: string,
  ): Promise<{ success: boolean; message: string; orderId?: number } | null> {
    try {
      const inquiry = await this.inquiryPayment(payment.refId, clientIp);

      // مدل TrackPurchase: آخرین وضعیت خرید در trackPurchaseList
      const track = inquiry?.trackPurchaseList?.[0];
      const result = String(track?.result ?? inquiry?.result ?? '');

      this.logger.log(
        `استعلام تارا برای پرداخت ${payment.id}: ${describeTaraResult(result)}`,
      );

      if (result !== TARA_SUCCESS_RESULT) {
        return null;
      }

      return await this.markPaymentSuccess(payment, inquiry, track);
    } catch (error) {
      this.logger.error(
        `❌ استعلام (purchaseInquiry) هم برای پرداخت ${payment.id} پاسخ نداد.`,
        error instanceof Error ? error.stack : String(error),
      );

      return null;
    }
  }

  // =========================================================
  // مشترک: ثبت موفقیت پرداخت و نهایی‌کردن سفارش
  // =========================================================

  private async markPaymentSuccess(
    payment: Payment,
    data: any,
    track?: any,
  ): Promise<{ success: boolean; message: string; orderId?: number }> {
    payment.status = PaymentStatus.SUCCESS;
    payment.resCode = TARA_SUCCESS_RESULT;

    // rrn در مستند از نوع string است (شماره مرجع پرداخت) — همان referenceNumber
    // موردنیاز سرویس‌های «برگشت خرید» است.
    const rrn = data?.rrn ?? track?.rrn;

    if (rrn != null && String(rrn).trim()) {
      payment.saleReferenceId = String(rrn).trim();
    }

    this.mergeGatewayResponse(payment, 'purchaseVerify', data);

    if (track) {
      this.mergeGatewayResponse(payment, 'purchaseInquiry', track);
    }

    await this.paymentRepo.save(payment);

    /*
     * تأیید نهایی سفارش (کاهش موجودی و خالی کردن سبد).
     * اگر خطا بدهد، پول گرفته شده؛ پس پرداخت SUCCESS می‌ماند
     * و سفارش لغو نمی‌شود تا دستی بررسی/اصلاح شود.
     */
    try {
      const order = await this.ordersService.findOneForAdmin(payment.orderId);

      if (order.status === OrderStatus.PENDING) {
        await this.ordersService.confirmOrderPayment(payment.orderId);
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
  // کمکی
  // =========================================================

  /**
   * خواندن پاسخ به‌صورت JSON همراه با بررسی وضعیت HTTP.
   * (بدون این کنترل، پاسخ خطای ۴۰۱/۵۰۰ به شکل خطای parse دیده می‌شد)
   */
  private async parseJsonResponse(response: Response, serviceName: string) {
    if (!response.ok) {
      const text = await response.text().catch(() => '');

      this.logger.error(
        `❌ تارا (${serviceName}) پاسخ HTTP ${response.status} داد: ${text.slice(0, 500)}`,
      );

      // توکن منقضی/باطل → کش پاک شود تا درخواست بعدی دوباره لاگین کند
      if (response.status === 401 || response.status === 403) {
        this.authService.clearToken();
      }

      throw new BadRequestException(
        `پاسخ نامعتبر از تارا (${serviceName}): HTTP ${response.status}`,
      );
    }

    return await response.json();
  }

  async findPaymentByRefId(refId: string) {
    return this.paymentRepo.findOne({
      where: {
        refId,
        gateway: PaymentGateway.TARA,
      },
    });
  }

  async failPayment(payment: Payment, resCode: string) {
    payment.status = PaymentStatus.FAILED;
    payment.resCode = resCode;

    return this.paymentRepo.save(payment);
  }

  /**
   * ذخیرهٔ اطلاعات callback تارا.
   * طبق مستند، تارا این فیلدها را به callBackUrl می‌فرستد:
   * result, desc, token, channelRefNumber, additionalData, orderId
   */
  async storeCallbackData(
    payment: Payment,
    callback: {
      result?: string;
      desc?: string;
      channelRefNumber?: string;
      additionalData?: string;
      orderId?: string;
    },
  ) {
    if (callback?.channelRefNumber) {
      payment.channelRefNumber = String(callback.channelRefNumber);
    }

    this.mergeGatewayResponse(payment, 'callback', callback);

    return this.paymentRepo.save(payment);
  }

  // =========================================================
  // همسان‌سازی پرداخت‌های بلاتکلیف (برای زمان‌بند)
  // =========================================================

  /**
   * تراکنش‌های بلاتکلیف تارا را با استعلام به نتیجه می‌رساند.
   *
   * اگر callback نرسد یا purchaseVerify ناتمام بماند، پرداخت PENDING می‌ماند
   * در حالی که ممکن است وجه کسر شده باشد. طبق مرحلهٔ ۶ فرایند مستند، با
   * purchaseInquiry از آخرین وضعیت خرید مطلع می‌شویم و در صورت موفق بودن،
   * سفارش نهایی می‌شود.
   *
   * برای استعلام‌های ناموفق، پس از سپری شدن مهلت ۳۰ دقیقه‌ایِ برگشت خودکار
   * وجه، وضعیت ناموفق ثبت می‌شود (سفارش لغو نمی‌شود تا کاربر بتواند دوباره
   * پرداخت کند).
   */
  async reconcilePendingPayments(limit = 25): Promise<void> {
    const deadline = new Date(
      Date.now() - TARA_RECONCILE_AFTER_MINUTES * 60_000,
    );

    const payments = await this.paymentRepo.find({
      where: {
        gateway: PaymentGateway.TARA,
        status: PaymentStatus.PENDING,
        createdAt: LessThan(deadline),
      },
      take: limit,
      order: { id: 'ASC' },
    });

    for (const payment of payments) {
      const result = await this.finalizeFromInquiry(
        payment,
        this.getStoredClientIp(payment),
      );

      if (result?.success) {
        this.logger.log(
          `✅ پرداخت بلاتکلیف ${payment.id} (سفارش ${payment.orderId}) با استعلام تارا موفق شناسایی و نهایی شد.`,
        );

        continue;
      }

      const ageMinutes =
        (Date.now() - new Date(payment.createdAt).getTime()) / 60_000;

      if (ageMinutes < TARA_AUTO_REFUND_MINUTES) {
        // هنوز ممکن است کاربر وسط پرداخت باشد یا استعلام بعداً پاسخ دهد
        continue;
      }

      this.logger.warn(
        `پرداخت ${payment.id} (سفارش ${payment.orderId}) بیش از ${TARA_AUTO_REFUND_MINUTES} دقیقه بلاتکلیف ماند و ` +
          'استعلام تارا هم موفق نبود؛ طبق مستند وجه به‌صورت خودکار برگشت می‌خورد.',
      );

      payment.status = PaymentStatus.FAILED;
      payment.resCode = payment.resCode || 'AUTO_REFUNDED';
      this.mergeGatewayResponse(
        payment,
        'reconciledAt',
        new Date().toISOString(),
      );
      await this.paymentRepo.save(payment);
    }
  }

  // =========================================================
  // کمکی
  // =========================================================

  /** IP ذخیره‌شدهٔ کاربر در زمان getToken (برای فراخوانی‌های بدون کاربر) */
  private getStoredClientIp(payment: Payment): string {
    const response = payment.gatewayResponse;

    if (response && typeof response === 'object' && !Array.isArray(response)) {
      const stored = (response as Record<string, unknown>).clientIp;

      if (typeof stored === 'string' && stored.trim()) {
        return stored.trim();
      }
    }

    return '';
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
}
