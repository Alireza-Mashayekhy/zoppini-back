// src/payment/services/digipay-payment.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { isIranMobile, normalizeIranMobile } from 'src/common/utils/phone.util';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { OrdersService } from 'src/order/order.service';
import { WalletChargeStatus } from 'src/wallet/entities/wallet-charge.entity';
import { LessThan, Not, Repository } from 'typeorm';

import {
  Payment,
  PaymentGateway,
  PaymentPurpose,
  PaymentStatus,
} from '../entities/payment.entity';
import {
  PaymentRefund,
  PaymentRefundStatus,
} from '../entities/payment-refund.entity';
import { describeDigipayPurchase } from '../utils/digipay-instrument.util';
import { DigipayAuthService } from './digipay-auth.service';
import { PaymentGuardService } from './payment-guard.service';
import { WalletChargeService } from './wallet-charge.service';

/** نوع تیکت UPG: «برای تمام فیچرهای روی UPG» (جدول ۴ مستند) */
const DIGIPAY_UPG_TICKET_TYPE = 11;

/**
 * نوع خرید دیجی‌پی در **callback** (جدول ۱۲ مستند).
 * توجه: با نوع تیکت اولیهٔ UPG (۱۱) اشتباه نشود.
 */
const DIGIPAY_PURCHASE_TYPE = {
  /** درگاه اینترنتی (IPG) — در مستند به‌صورت صریح نیامده ولی برگشتیِ IPG است */
  IPG: 0,
  WALLET: 11,
  CREDIT: 5,
  BNPL: 13,
  CREDIT_CARD: 24,
} as const;

/** نوع‌هایی که verify با آن‌ها مجاز است (`purchases/verify?type=`) */
const DIGIPAY_VERIFY_TICKET_TYPES = new Set<number>([
  DIGIPAY_PURCHASE_TYPE.IPG,
  DIGIPAY_PURCHASE_TYPE.WALLET,
  DIGIPAY_PURCHASE_TYPE.CREDIT,
  DIGIPAY_PURCHASE_TYPE.BNPL,
  DIGIPAY_PURCHASE_TYPE.CREDIT_CARD,
]);

/**
 * نگاشت ابزار واقعی پرداخت (پاسخ verify) به نوع خرید (callback).
 * برای بازگشت‌هایی که فیلد `type` را ندارند، یا وقتی مقدار callback با ابزار
 * واقعی نمی‌خواند، این نگاشت منبع حقیقت است (پول از همین مسیر حرکت کرده).
 */
const DIGIPAY_PURCHASE_TYPE_BY_INSTRUMENT: Record<number, number> = {
  3: DIGIPAY_PURCHASE_TYPE.WALLET,
  4: DIGIPAY_PURCHASE_TYPE.CREDIT,
  10: DIGIPAY_PURCHASE_TYPE.BNPL,
};

/** خریدهای اعتباری/اقساطی: Delivery اجباری است (بند ۱۰ مستند) */
const DIGIPAY_CREDIT_PURCHASE_TYPES = new Set<number>([
  DIGIPAY_PURCHASE_TYPE.CREDIT,
  DIGIPAY_PURCHASE_TYPE.BNPL,
]);

/**
 * نگاشت `paymentGateway` پاسخ verify به نوع عودت Refund (جدول ۱۶ و جدول نوع عودت).
 * برای Refund نباید `paymentGateway` را مستقیم فرستاد؛ نوع عودت جدول خودش را دارد.
 */
const DIGIPAY_REFUND_TYPE_BY_PURCHASE_TYPE: Record<number, number> = {
  [DIGIPAY_PURCHASE_TYPE.IPG]: 0, // Debit؛ عودت خودکار
  [DIGIPAY_PURCHASE_TYPE.WALLET]: 11,
  [DIGIPAY_PURCHASE_TYPE.CREDIT]: 5,
  [DIGIPAY_PURCHASE_TYPE.BNPL]: 13,
};

/**
 * کدهایی که یعنی «نتیجهٔ تأیید هنوز قطعی نیست» (جدول ۳۰ مستند):
 * 9004 = خرید در حال انجام، 9006 = خطای ارتباط با درگاه، 9011 = نتیجه نامشخص.
 * این‌ها و همچنین خطای شبکه/HTTP بدون بدنهٔ بیزینسی نباید پرداخت را FAILED کنند،
 * چون ممکن است وجه کسر شده باشد و باید دوباره استعلام شود.
 */
const DIGIPAY_INCONCLUSIVE_RESULT_CODES = new Set(['9004', '9006', '9011']);

/**
 * کدهای خطای قطعی Refund (جدول خطاهای Refund): یعنی درخواست جدید ثبت **نشده**
 * است و می‌توان پس از رفع علت، درخواست تازه ساخت. بقیهٔ کدها/خطاهای شبکه
 * «نامعلوم» هستند و فقط با Refund Inquiry قابل حل‌اند.
 */
const DIGIPAY_REFUND_DEFINITE_ERROR_CODES = new Set([
  '1054',
  '1121',
  '6024',
  '6312',
  '6313',
  '9022',
  '9035',
  '9036',
  '10205',
]);

/** وضعیت عودت در پاسخ Refund Inquiry (جدول ۲۸ مستند) */
const DIGIPAY_REFUND_INQUIRY_STATUS = {
  SUCCESS: 0,
  FAILED: 1,
  PENDING: 2,
} as const;

type DigipayCallbackData = {
  amount?: string;
  providerId?: string;
  trackingCode?: string;
  rrn?: string;
  psp?: unknown;
  isCredit?: string;
  creditProvider?: string;
  repaymentOption?: string;
  type?: string;
  result?: string;
};

type DigipayOperationResult = {
  success: boolean;
  pending?: boolean;
  message: string;
  orderId?: number;
};

type DigipayApiResult = {
  ok: boolean;
  status: number;
  data: any;
};

type DigipayBasketDetails = {
  basketId: string;
  items: {
    productCode: string;
    brand: string;
    productType: number;
    count: number;
  }[];
};

@Injectable()
export class DigipayPaymentService {
  private readonly logger = new Logger(DigipayPaymentService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    @InjectRepository(PaymentRefund)
    private readonly refundRepo: Repository<PaymentRefund>,
    private readonly ordersService: OrdersService,
    private readonly authService: DigipayAuthService,

    private readonly paymentGuard: PaymentGuardService,
    private readonly walletChargeService: WalletChargeService,
  ) {}

  //==============================================================
  // تنظیمات
  //==============================================================

  private getRequiredConfig(name: string): string {
    const value = this.configService.get<string>(name)?.trim();

    if (!value) {
      throw new BadRequestException(`${name} تنظیم نشده است`);
    }

    return value;
  }

  private getApiUrl(): string {
    return this.getRequiredConfig('DIGIPAY_API_URL').replace(/\/+$/, '');
  }

  private getCallbackUrl(): string {
    const configured = this.configService
      .get<string>('DIGIPAY_PAYMENT_CALLBACK_URL')
      ?.trim();

    if (configured) {
      return configured;
    }

    const appUrl =
      this.configService.get<string>('APP_URL')?.trim() ||
      this.configService.get<string>('FRONT_URL')?.trim();

    if (!appUrl) {
      throw new BadRequestException(
        'DIGIPAY_PAYMENT_CALLBACK_URL یا APP_URL تنظیم نشده است',
      );
    }

    return `${appUrl.replace(/\/+$/, '')}/api/payment/callback/digipay`;
  }

  /**
   * حالت تیکت خرید:
   * - `upg` (پیش‌فرض): صفحهٔ انتخاب روش پرداخت دیجی‌پی (کیف پول / اعتبار / قسطی / IPG)
   *   به کاربر نشان داده می‌شود؛ نیازمند قرارداد BPG/CPG با دیجی‌پی.
   * - `ipg`: فقط درگاه اینترنتی (شتاب)؛ برای پذیرندگانی که هنوز اعتباری فعال ندارند.
   *
   * نکته: `preferredGateway` در مستند رسمی UPG نیامده و استفاده از آن
   * صفحهٔ انتخاب روش پرداخت را غیرفعال می‌کند؛ فقط در حالت ipg فرستاده می‌شود.
   */
  private getUpgMode(): 'upg' | 'ipg' {
    const value = this.configService
      .get<string>('DIGIPAY_UPG_MODE')
      ?.trim()
      .toLowerCase();

    return value === 'ipg' ? 'ipg' : 'upg';
  }

  /** نام برند برای `basketDetailsDto.items[].brand` (فروشگاه تک‌برند است) */
  private getBasketBrand(): string {
    const brand = this.configService
      .get<string>('DIGIPAY_BASKET_BRAND')
      ?.trim();

    return brand || 'ZOPPINI';
  }

  /**
   * نوع کالا برای `basketDetailsDto.items[].productType` (جدول ۹):
   * 1=بادوام، 2=مصرفی، 3=سرویس، 4=مصرفی بادوام. پوشاک بادوام است.
   */
  private getBasketProductType(): number {
    const raw = Number(
      this.configService.get<string>('DIGIPAY_BASKET_PRODUCT_TYPE'),
    );

    return [1, 2, 3, 4].includes(raw) ? raw : 1;
  }

  /** عودت خودکار وجه درگاه برای سفارش‌های لغوشده (پیش‌فرض: روشن) */
  private isAutoRefundEnabled(): boolean {
    const value = this.configService
      .get<string>('DIGIPAY_AUTO_REFUND')
      ?.trim()
      .toLowerCase();

    return value !== 'false' && value !== '0';
  }

  //==============================================================
  // ابزارهای عمومی
  //==============================================================

  private toGatewayAmount(amountInToman: number): number {
    const amount = Math.round(Number(amountInToman) * 10);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('مبلغ پرداخت نامعتبر است');
    }
    return amount;
  }

  private getOrderCardAmount(order: Order): number {
    const walletPayment = Number(order.walletPayment ?? 0);

    return this.toGatewayAmount(Number(order.finalPrice) - walletPayment);
  }

  /**
   * مستند: `cellNumber` باید با صفر ابتدایی و قالب `09xxxxxxxxx` ارسال شود.
   * شماره‌های ذخیره‌شده ممکن است فارسی/بین‌المللی یا با فاصله باشند، پس با
   * همان ابزار مشترک پروژه نرمال و بعد اعتبارسنجی می‌شوند؛ در غیر این صورت
   * دیجی‌پی خطای 1054/9030 می‌دهد.
   */
  private getUserPhone(phone: unknown): string {
    const normalized = normalizeIranMobile(
      typeof phone === 'string' ? phone.trim() : phone,
    );

    if (
      typeof normalized !== 'string' ||
      !normalized.trim() ||
      !isIranMobile(normalized)
    ) {
      throw new BadRequestException(
        'شماره همراه کاربر برای پرداخت دیجی‌پی معتبر نیست (قالب صحیح: 09xxxxxxxxx)',
      );
    }

    return normalized;
  }

  private async readJsonResponse(
    response: Response,
    operation: string,
    options: { allowEmpty?: boolean } = {},
  ): Promise<any> {
    const responseText = await response.text();

    if (!responseText.trim()) {
      if (options.allowEmpty) {
        return {};
      }

      throw new Error(`پاسخ خالی از دیجی‌پی در عملیات ${operation}`);
    }

    try {
      return JSON.parse(responseText);
    } catch {
      throw new Error(`پاسخ دیجی‌پی در عملیات ${operation} JSON معتبر نیست`);
    }
  }

  private getResultStatus(data: any): number | null {
    const value = Number(data?.result?.status);

    return Number.isFinite(value) ? value : null;
  }

  private getResultMessage(data: any, fallback: string): string {
    return (
      data?.result?.message ||
      data?.message ||
      data?.error_description ||
      fallback
    );
  }

  /**
   * فراخوانی یک سرویس دیجی‌پی با توکن Bearer.
   *
   * اگر درگاه 401/403 بدهد (توکن منقضی/باطل)، توکن پاک می‌شود و **همان
   * درخواست یک‌بار دیگر** با توکن تازه تکرار می‌شود؛ بدون این کار یک
   * انقضای توکن باعث می‌شد verify در پنجرهٔ ۳ دقیقه‌ای Auto Reverse بماند.
   */
  private async callDigipayApi(params: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    operation: string;
    allowEmptyResponse?: boolean;
  }): Promise<DigipayApiResult> {
    const url = `${this.getApiUrl()}${params.path}`;
    const maxAttempts = 2;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const accessToken = await this.authService.getAccessToken();

      try {
        const response = await fetch(url, {
          method: params.method,
          headers: {
            Agent: 'WEB',
            'Digipay-Version': '2022-02-02',
            Authorization: `Bearer ${accessToken}`,
            ...(params.body === undefined
              ? {}
              : { 'Content-Type': 'application/json; charset=UTF-8' }),
          },
          ...(params.body === undefined
            ? {}
            : { body: JSON.stringify(params.body) }),
        });

        if (
          (response.status === 401 || response.status === 403) &&
          attempt < maxAttempts
        ) {
          this.logger.warn(
            `توکن دیجی‌پی در ${params.operation} پذیرفته نشد (${response.status})؛ توکن تازه گرفته می‌شود`,
          );
          this.authService.clearToken();
          continue;
        }

        const data = await this.readJsonResponse(response, params.operation, {
          allowEmpty: params.allowEmptyResponse,
        });

        return { ok: response.ok, status: response.status, data };
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // خطای شبکه/پارس: تلاش دوم فقط برای خطای احراز هویت معنا دارد
        break;
      }
    }

    throw (
      lastError ?? new Error(`خطا در ارتباط با دیجی‌پی (${params.operation})`)
    );
  }

  //==============================================================
  // ساخت سبد خرید (basketDetailsDto)
  //==============================================================

  /**
   * جزییات سبد خرید برای پرداخت‌های Credit و BNPL (بند ۷-۳ مستند).
   *
   * - `basketId`: حداکثر ۳۰ کاراکتر و یکتا برای همین سبد
   * - هر آیتم: `productCode`، `brand`، `productType` (عددی)، `count`
   *
   * کدهای یکسان (مثلاً دو سایز از یک محصول) در یک آیتم با `count` جمع می‌شوند.
   */
  private buildBasketDetails(order: Order): DigipayBasketDetails | undefined {
    const byProductCode = new Map<string, number>();

    for (const item of order.items ?? []) {
      const product = item.variant?.product;

      const code = String(
        product?.productCode || item.variant?.sku || `ITEM-${item.id}`,
      ).trim();

      if (!code) {
        continue;
      }

      const count = Math.max(1, Math.round(Number(item.quantity ?? 1)));

      byProductCode.set(code, (byProductCode.get(code) ?? 0) + count);
    }

    if (!byProductCode.size) {
      return undefined;
    }

    const brand = this.getBasketBrand();
    const productType = this.getBasketProductType();

    return {
      // یکتایی per-attempt: سبد یک سفارش اگر مبلغش عوض شود شناسهٔ تازه می‌گیرد
      basketId: `basket-${order.id}-${Date.now().toString(36)}`.slice(0, 30),
      items: [...byProductCode.entries()].map(([productCode, count]) => ({
        productCode: productCode.slice(0, 50),
        brand,
        productType,
        count,
      })),
    };
  }

  /** نوع خرید برای پارامتر `type` سرویس Refund / Delivery */
  private resolvePurchaseType(payment: Payment): number | null {
    const stored = this.normalizeTicketType(
      payment.digipayPurchaseType ?? this.getStoredCallback(payment).type,
    );

    return stored;
  }

  /**
   * نوع عودت (Refund) بر اساس نوع خرید.
   *
   * `null` یعنی این نوع خرید در «جدول نوع عودت» مستند نیامده (مثل CREDIT-CARD
   * با کد ۲۴) و نوع عودت باید با پشتیبانی دیجی‌پی هماهنگ شود؛ حدس زدن نوع
   * می‌تواند وجه را به مسیر اشتباه برگرداند.
   */
  private resolveRefundType(payment: Payment): number | null {
    const purchaseType = this.resolvePurchaseType(payment);

    if (purchaseType === null) {
      // بدون نوع مشخص (پرداخت‌های قدیمی IPG)، عودت خودکار Debit امن‌ترین است
      return 0;
    }

    return DIGIPAY_REFUND_TYPE_BY_PURCHASE_TYPE[purchaseType] ?? null;
  }

  //==============================================================
  // تیکت خرید
  //==============================================================

  private buildTicketPayload(params: {
    amount: number;
    cellNumber: string;
    providerId: string;
    callbackUrl: string;
    basketDetails?: DigipayBasketDetails;
    forceIpg?: boolean;
  }): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      cellNumber: params.cellNumber,
      amount: params.amount,
      providerId: params.providerId,
      callbackUrl: params.callbackUrl,
    };

    if (params.basketDetails) {
      payload.basketDetailsDto = params.basketDetails;
    }

    /*
     * در حالت ipg (یا شارژ کیف پول) صفحهٔ انتخاب روش پرداخت نمایش داده نمی‌شود
     * و کاربر مستقیم به درگاه اینترنتی می‌رود. در حالت upg این فیلد عمداً
     * فرستاده نمی‌شود تا صفحهٔ انتخاب BPG/CPG/Wallet باز شود.
     */
    if (params.forceIpg || this.getUpgMode() === 'ipg') {
      payload.additionalInfo = { preferredGateway: 2 };
    }

    return payload;
  }

  private async requestTicket(params: {
    amount: number;
    cellNumber: string;
    providerId: string;
    callbackUrl: string;
    basketDetails?: DigipayBasketDetails;
    forceIpg?: boolean;
  }): Promise<{ ticket: string; payUrl: string; response: any }> {
    const payload = this.buildTicketPayload(params);

    this.logger.log(
      `ایجاد تیکت دیجی‌پی: amount=${params.amount}, providerId=${params.providerId}, ` +
        `upgMode=${this.getUpgMode()}, basket=${Boolean(params.basketDetails)}`,
    );

    const { ok, status, data } = await this.callDigipayApi({
      method: 'POST',
      path: `/tickets/business?type=${DIGIPAY_UPG_TICKET_TYPE}`,
      body: payload,
      operation: 'tickets/business',
    });

    const resultStatus = this.getResultStatus(data);

    if (!ok || resultStatus !== 0) {
      throw new BadRequestException(
        this.getResultMessage(data, `خطای دیجی‌پی (${status})`),
      );
    }

    const ticket =
      typeof data?.ticket === 'string'
        ? data.ticket.trim()
        : String(data?.ticket || '');
    const payUrl =
      typeof data?.redirectUrl === 'string'
        ? data.redirectUrl.trim()
        : String(data?.redirectUrl || '');

    if (!ticket) {
      throw new BadRequestException('Ticket از دیجی‌پی دریافت نشد');
    }

    if (!payUrl) {
      throw new BadRequestException('Redirect URL از دیجی‌پی دریافت نشد');
    }

    return { ticket, payUrl, response: data };
  }

  async requestPayment(
    orderId: number,
    userId: number,
  ): Promise<{ refId: string; payUrl: string }> {
    const order = await this.ordersService.findOneForPayment(orderId, userId);

    if (!order) {
      throw new BadRequestException('سفارش یافت نشد');
    }

    await this.paymentGuard.ensureOrderPayable(order);

    const amount = this.getOrderCardAmount(order);
    const providerId = `ORDER-${orderId}-${Date.now()}`;
    const callbackUrl = this.getCallbackUrl();
    const cellNumber = this.getUserPhone(order.user?.phone);
    const basketDetails = this.buildBasketDetails(order);

    if (!basketDetails && this.getUpgMode() === 'upg') {
      this.logger.warn(
        `سبد خرید سفارش ${orderId} خالی است؛ basketDetailsDto به دیجی‌پی ارسال نمی‌شود ` +
          'و احتمالاً پرداخت اعتباری/اقساطی برای این خرید ممکن نیست.',
      );
    }

    try {
      const ticket = await this.requestTicket({
        amount,
        cellNumber,
        providerId,
        callbackUrl,
        basketDetails,
      });

      const payment = this.paymentRepo.create({
        orderId,
        purpose: PaymentPurpose.ORDER,
        walletChargeId: null,
        refId: ticket.ticket,
        providerId,
        amount,
        gateway: PaymentGateway.DIGIPAY,
        status: PaymentStatus.PENDING,
        resCode: '0',
        gatewayResponse: {
          request: {
            providerId,
            amount,
            type: DIGIPAY_UPG_TICKET_TYPE,
            upgMode: this.getUpgMode(),
            basketDetails: basketDetails ?? null,
            cellNumber,
          },
          ticketResponse: ticket.response,
        },
      });

      await this.paymentRepo.save(payment);

      return {
        refId: ticket.ticket,
        payUrl: ticket.payUrl,
      };
    } catch (error: any) {
      this.logger.error(
        '❌ خطا در درخواست پرداخت دیجی‌پی',
        error?.stack || error,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException('خطا در ارتباط با درگاه دیجی‌پی');
    }
  }

  /**
   * شارژ کیف پول از طریق دیجی‌پی.
   *
   * نکته: شارژ کیف پول «خرید کالا» نیست و پرداخت اقساطی/اعتباری برای آن معنا
   * ندارد؛ بنابراین در این مسیر همیشه درگاه اینترنتی (IPG) انتخاب می‌شود و
   * basketDetailsDto فرستاده نمی‌شود.
   */
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

    const amount = this.toGatewayAmount(Number(charge.amount));
    const providerId = `WALLET-${chargeId}-${Date.now()}`;

    const callbackUrl = this.getCallbackUrl();
    const cellNumber = this.getUserPhone(charge.user?.phone);

    try {
      const ticket = await this.requestTicket({
        amount,
        cellNumber,
        providerId,
        callbackUrl,
        forceIpg: true,
      });

      const payment = this.paymentRepo.create({
        orderId: null,
        walletChargeId: charge.id,
        purpose: PaymentPurpose.WALLET_CHARGE,
        refId: ticket.ticket,
        providerId,
        amount,
        gateway: PaymentGateway.DIGIPAY,
        status: PaymentStatus.PENDING,
        resCode: '0',
        gatewayResponse: {
          request: {
            providerId,
            amount,
            type: DIGIPAY_UPG_TICKET_TYPE,
            upgMode: 'ipg',
            forceIpg: true,
            cellNumber,
          },
          ticketResponse: ticket.response,
        },
      });

      await this.paymentRepo.save(payment);

      return {
        refId: ticket.ticket,
        payUrl: ticket.payUrl,
      };
    } catch (error: any) {
      this.logger.error(
        '❌ خطا در درخواست شارژ کیف پول از دیجی‌پی',
        error?.stack || error,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException('خطا در ارتباط با درگاه دیجی‌پی');
    }
  }

  //==============================================================
  // Callback
  //==============================================================

  async recordCallback(
    payment: Payment,
    callback: DigipayCallbackData,
  ): Promise<void> {
    this.applyCallbackData(payment, callback);
    await this.paymentRepo.save(payment);
  }

  private applyCallbackData(
    payment: Payment,
    callback: DigipayCallbackData,
  ): void {
    if (callback.providerId?.trim() && !payment.providerId) {
      payment.providerId = callback.providerId.trim();
    }

    if (callback.trackingCode?.trim()) {
      payment.saleReferenceId = callback.trackingCode.trim();
    }

    /*
     * نوع خرید فقط از callback معلوم می‌شود (جدول ۱۲) و مبنای verify، Delivery
     * و Refund است؛ پس باید در ستون ذخیره شود تا بعداً هم در دسترس باشد.
     */
    const purchaseType = this.normalizeTicketType(callback.type);

    if (purchaseType !== null) {
      payment.digipayPurchaseType = purchaseType;
    }

    const creditProvider = callback.creditProvider?.trim();

    if (creditProvider) {
      payment.creditProvider = creditProvider.slice(0, 64);
    }

    const repaymentOption = Number(callback.repaymentOption);

    if (
      callback.repaymentOption !== undefined &&
      callback.repaymentOption !== '' &&
      Number.isInteger(repaymentOption) &&
      repaymentOption >= 0
    ) {
      payment.repaymentOption = repaymentOption;
    }

    this.mergeGatewayResponse(payment, 'callback', callback);
  }

  //==============================================================
  // تأیید پرداخت
  //==============================================================

  async verifyPayment(
    payment: Payment,
    callback?: DigipayCallbackData,
  ): Promise<DigipayOperationResult> {
    if (payment.status === PaymentStatus.SUCCESS) {
      return {
        success: true,
        pending: false,
        message: 'پرداخت قبلاً تأیید شده است',
        orderId: payment.orderId ?? undefined,
      };
    }

    if (callback) {
      await this.recordCallback(payment, callback);
    }

    const storedCallback = this.getStoredCallback(payment);
    const providerId = payment.providerId?.trim();
    const trackingCode =
      callback?.trackingCode?.trim() || storedCallback.trackingCode?.trim();
    /*
     * نوع خرید از callback می‌آید؛ اگر در این بازگشت نبود (بازگشت تکراری یا
     * نسخهٔ کوتاه callback)، از نوع ذخیره‌شده روی خود پرداخت استفاده می‌شود.
     */
    const type =
      this.normalizeTicketType(callback?.type ?? storedCallback.type) ??
      this.normalizeTicketType(payment.digipayPurchaseType);

    if (!providerId || !trackingCode || type === null) {
      this.logger.warn(
        `اطلاعات لازم برای verify دیجی‌پی ناقص است (payment=${payment.id}, ` +
          `providerId=${Boolean(providerId)}, trackingCode=${Boolean(trackingCode)}, type=${type})`,
      );

      return this.pendingResult(
        payment,
        'اطلاعات کامل برای تأیید پرداخت دریافت نشد',
      );
    }

    if (callback?.providerId && callback.providerId.trim() !== providerId) {
      this.logger.error(
        `❌ providerId callback دیجی‌پی با پرداخت ${payment.id} مطابقت ندارد`,
      );

      return this.pendingResult(
        payment,
        'شناسه پرداخت با اطلاعات ثبت‌شده مطابقت ندارد',
      );
    }

    const callbackAmount = callback?.amount || storedCallback.amount;

    if (!this.amountMatches(callbackAmount, payment.amount)) {
      this.logger.error(
        `❌ مبلغ callback دیجی‌پی برای پرداخت ${payment.id} معتبر نیست: ` +
          `expected=${payment.amount}, received=${callbackAmount || 'empty'}`,
      );

      return this.pendingResult(
        payment,
        'مبلغ تراکنش با مبلغ سفارش مطابقت ندارد',
      );
    }

    try {
      this.logger.log(
        `تأیید پرداخت دیجی‌پی: payment=${payment.id}, type=${type}, providerId=${providerId}`,
      );

      const { ok, status, data } = await this.callDigipayApi({
        method: 'POST',
        path: `/purchases/verify?type=${type}`,
        body: { trackingCode, providerId },
        operation: 'purchases/verify',
      });

      const resultStatus = this.getResultStatus(data);

      if (resultStatus !== 0) {
        const resultCode =
          resultStatus === null ? String(status) : String(resultStatus);

        this.mergeGatewayResponse(payment, 'verify', data);
        payment.resCode = resultCode;

        // خطای HTTP بدون بدنهٔ بیزینسی و وضعیت‌های نامشخص نباید پرداخت را
        // قطعی ناموفق کنند؛ ممکن است وجه کسر شده باشد.
        if (
          resultStatus === null ||
          (status !== 422 && !ok) ||
          DIGIPAY_INCONCLUSIVE_RESULT_CODES.has(resultCode)
        ) {
          await this.paymentRepo.save(payment);
          return this.pendingResult(
            payment,
            this.getResultMessage(
              data,
              'نتیجهٔ تأیید پرداخت دیجی‌پی هنوز مشخص نیست',
            ),
          );
        }

        return this.markPaymentFailed(
          payment,
          resultCode,
          this.getResultMessage(data, 'تأیید پرداخت دیجی‌پی ناموفق بود'),
        );
      }

      if (!ok) {
        await this.paymentRepo.save(payment);
        return this.pendingResult(
          payment,
          'پاسخ تأیید پرداخت دیجی‌پی معتبر نیست',
        );
      }

      const responseProviderId = this.asTrimmedString(data?.providerId);

      if (!responseProviderId || responseProviderId !== providerId) {
        this.logger.error(
          `❌ providerId پاسخ verify دیجی‌پی برای پرداخت ${payment.id} معتبر نیست`,
        );

        this.mergeGatewayResponse(payment, 'verify', data);
        await this.paymentRepo.save(payment);
        return this.pendingResult(payment, 'شناسهٔ تراکنش تأییدشده معتبر نیست');
      }

      const responseTrackingCode = this.asTrimmedString(data?.trackingCode);
      const responseAmount = data?.amount;

      if (
        !responseTrackingCode ||
        !this.amountMatches(responseAmount, payment.amount)
      ) {
        this.logger.error(
          `❌ مبلغ یا کد پیگیری پاسخ verify دیجی‌پی برای پرداخت ${payment.id} معتبر نیست`,
        );

        this.mergeGatewayResponse(payment, 'verify', data);
        await this.paymentRepo.save(payment);
        return this.pendingResult(
          payment,
          'اطلاعات تراکنش تأییدشده معتبر نیست',
        );
      }

      payment.status = PaymentStatus.SUCCESS;
      payment.resCode = '0';
      payment.saleReferenceId = responseTrackingCode;
      this.applyVerifyDetails(payment, data, type);
      this.mergeGatewayResponse(payment, 'verify', data);
      await this.paymentRepo.save(payment);

      return this.finalizeSuccessfulPayment(payment);
    } catch (error) {
      this.logger.error(
        `❌ خطا در تأیید پرداخت دیجی‌پی برای پرداخت ${payment.id}; وضعیت PENDING می‌ماند`,
        error instanceof Error ? error.stack : String(error),
      );

      return this.pendingResult(
        payment,
        'خطا در تأیید پرداخت؛ تراکنش در حال بررسی است',
      );
    }
  }

  /**
   * ثبت اطلاعات خرید اعتباری از پاسخ verify:
   * `paymentGateway` (ابزار واقعی)، `fpName` (تأمین‌کنندهٔ اعتبار) و
   * `additionalInfo` (تقسیم نقدی/اعتباری) — جدول ۱۵ تا ۱۷ مستند.
   */
  private applyVerifyDetails(
    payment: Payment,
    data: any,
    purchaseType: number | null,
  ): void {
    if (purchaseType !== null && payment.digipayPurchaseType === null) {
      payment.digipayPurchaseType = purchaseType;
    }

    const instrument = Number(data?.paymentGateway);

    if ([3, 4, 10].includes(instrument)) {
      payment.digipayPaymentGateway = instrument;

      /*
       * ابزار واقعی پرداخت، دقیق‌ترین منبع «نوع خرید» است. اگر callback نوع
       * نداشته باشد یا با ابزار واقعی نخواند، نوع از اینجا اصلاح می‌شود تا
       * Delivery و Refund با نوع درست انجام شوند (مثلاً پرداخت با کیف پول
       * دیجی‌پی نباید به‌عنوان IPG عودت داده شود).
       */
      const derivedType = DIGIPAY_PURCHASE_TYPE_BY_INSTRUMENT[instrument];

      if (
        derivedType !== undefined &&
        payment.digipayPurchaseType !== derivedType
      ) {
        if (payment.digipayPurchaseType !== null) {
          this.logger.warn(
            `نوع خرید دیجی‌پی برای پرداخت ${payment.id} با ابزار تأییدشده نمی‌خواند ` +
              `(callback=${payment.digipayPurchaseType}, instrument=${instrument})؛ مقدار ابزار ملاک قرار گرفت.`,
          );
        }

        payment.digipayPurchaseType = derivedType;
      }
    }

    const creditProvider = this.asTrimmedString(
      data?.fpName || data?.creditProvider,
    );

    if (creditProvider) {
      payment.creditProvider = creditProvider.slice(0, 64);
    }
  }

  /** برچسب خوانای ابزار پرداخت برای نمایش در پنل/گزارش */
  getInstrumentLabel(payment: Payment): string | null {
    return describeDigipayPurchase(payment)?.label ?? null;
  }

  //==============================================================
  // همسان‌سازی پرداخت‌های نیمه‌کاره
  //==============================================================

  /**
   * تلاش مجدد برای پرداخت‌هایی که callback موفق گرفته‌اند اما verify آن‌ها
   * به علت timeout/خطای موقت کامل نشده است.
   *
   * `cutoffMs` عمداً کمتر از ۳ دقیقه (مهلت Auto Reverse دیجی‌پی) انتخاب
   * می‌شود تا scheduler بتواند پیش از برگشت خودکار وجه، verify را کامل کند.
   */
  async reconcilePendingPayments(
    limit = 25,
    cutoffMs = 2 * 60_000,
  ): Promise<void> {
    const cutoff = new Date(Date.now() - Math.max(0, cutoffMs));
    const expiredCutoff = new Date(Date.now() - 24 * 60 * 60_000);

    const payments = await this.paymentRepo.find({
      where: {
        gateway: PaymentGateway.DIGIPAY,
        status: PaymentStatus.PENDING,
        createdAt: LessThan(cutoff),
      },
      take: limit,
      order: { id: 'ASC' },
    });

    for (const payment of payments) {
      const callback = this.getStoredCallback(payment);
      const result = this.normalizeResult(callback.result);

      /*
       * مستند UPG می‌گوید فیلد `result` ممکن است در بازگشت وجود نداشته باشد
       * (نمونهٔ Wallet حتی آن را ندارد). پس «نبودن result» به‌معنای شکست نیست؛
       * اگر trackingCode داشته باشیم، verify تنها منبع حقیقت است.
       *
       * «نشانهٔ پرداخت» یعنی callback پیام موفق/بی‌نتیجه با کد پیگیری دارد.
       * بدون این نشانه‌ها طبق مستند امکان verify وجود ندارد (کاربر صفحهٔ درگاه
       * را بسته و callback با FAILURE قبلاً نهایی شده است).
       */
      const hasPaymentSignals =
        Boolean(callback.trackingCode) &&
        (result === 'SUCCESS' || result === '');

      const type =
        this.normalizeTicketType(callback.type) ??
        this.normalizeTicketType(payment.digipayPurchaseType);

      if (hasPaymentSignals && type !== null) {
        await this.verifyPayment(payment, callback);
        continue;
      }

      if (hasPaymentSignals) {
        /*
         * پول احتمالاً گرفته شده ولی نوع خرید (type) برای verify معلوم نیست.
         * اینجا هرگز پرداخت را FAILED/EXPIRED نمی‌کنیم؛ فقط برای بررسی دستی
         * هشدار می‌دهیم تا پول کاربر گم نشود.
         */
        this.logger.error(
          `❌ پرداخت دیجی‌پی ${payment.id} callback موفق دارد ولی نوع خرید (type) ` +
            'مشخص نیست؛ verify انجام نشد و نیاز به بررسی دستی دارد.',
        );

        continue;
      }

      /*
       * پرداخت‌های رهاشده (کاربر صفحهٔ درگاه را بست) اگر بی‌نهایت PENDING
       * بمانند، صف همسان‌سازی را اشغال می‌کنند و پرداخت‌های تازه هرگز بررسی
       * نمی‌شوند. بعد از ۲۴ ساعت بسته می‌شوند؛ سفارش PENDING می‌ماند تا کاربر
       * بتواند دوباره پرداخت کند (همان رفتار PaymentGuard با STALE).
       */
      if (payment.createdAt && payment.createdAt < expiredCutoff) {
        payment.status = PaymentStatus.FAILED;
        payment.resCode = 'EXPIRED';
        await this.paymentRepo.save(payment);

        this.logger.warn(
          `پرداخت دیجی‌پی ${payment.id} پس از ۲۴ ساعت بدون callback موفق بسته شد (EXPIRED).`,
        );
      }
    }
  }

  async findPaymentByProviderId(providerId: string): Promise<Payment | null> {
    const normalized = providerId.trim();

    if (!normalized) {
      return null;
    }

    return this.paymentRepo.findOne({
      where: {
        providerId: normalized,
        gateway: PaymentGateway.DIGIPAY,
      },
    });
  }

  async findPaymentByRefId(refId: string): Promise<Payment | null> {
    return this.paymentRepo.findOne({
      where: {
        refId,
        gateway: PaymentGateway.DIGIPAY,
      },
    });
  }

  /** برای callbackهایی که providerId ندارند ولی trackingCode دارند */
  async findPaymentBySaleReferenceId(
    trackingCode: string,
  ): Promise<Payment | null> {
    const normalized = trackingCode.trim();

    if (!normalized) {
      return null;
    }

    return this.paymentRepo.findOne({
      where: {
        saleReferenceId: normalized,
        gateway: PaymentGateway.DIGIPAY,
      },
    });
  }

  //==============================================================
  // اعلام تحویل خرید اعتباری (Delivery Order — بند ۱۰)
  //==============================================================

  /**
   * تحویل خرید اعتباری/BNPL را به دیجی‌پی اعلام می‌کند.
   *
   * فقط برای خریدهای CREDIT (5) و BNPL (13) لازم است و برای بقیه بی‌اثر
   * (skip) است. سرویس idempotent است و در تکرار، HTTP 200 برمی‌گرداند.
   */
  async deliverPurchase(payment: Payment): Promise<{
    sent: boolean;
    success: boolean;
    pending?: boolean;
    message: string;
  }> {
    if (payment.gateway !== PaymentGateway.DIGIPAY) {
      return { sent: false, success: false, message: 'درگاه دیجی‌پی نیست' };
    }

    if (payment.status !== PaymentStatus.SUCCESS) {
      return {
        sent: false,
        success: false,
        message: 'پرداخت هنوز موفق/تأییدشده نیست',
      };
    }

    if (payment.digipayDeliveredAt) {
      return {
        sent: false,
        success: true,
        message: 'تحویل این خرید قبلاً به دیجی‌پی اعلام شده است',
      };
    }

    const purchaseType = this.resolvePurchaseType(payment);

    if (
      purchaseType === null ||
      !DIGIPAY_CREDIT_PURCHASE_TYPES.has(purchaseType)
    ) {
      return {
        sent: false,
        success: false,
        message: 'اعلام تحویل فقط برای خریدهای اعتباری و BNPL لازم است',
      };
    }

    const trackingCode = payment.saleReferenceId?.trim();

    if (!trackingCode) {
      return {
        sent: false,
        success: false,
        message: 'کد پیگیری خرید برای اعلام تحویل موجود نیست',
      };
    }

    if (!payment.orderId) {
      return {
        sent: false,
        success: false,
        message: 'این پرداخت به سفارشی متصل نیست',
      };
    }

    const order = await this.ordersService.findOneForAdmin(payment.orderId);

    const products = (order.items ?? [])
      .map(item => {
        const parts = [
          item.variant?.product?.title,
          item.variant?.color?.name,
          item.variant?.size?.name,
        ].filter(Boolean) as string[];

        return parts.join(' - ');
      })
      .filter(name => name.trim().length > 0);

    if (!products.length) {
      return {
        sent: false,
        success: false,
        message: 'نام محصولات سفارش برای اعلام تحویل خالی است',
      };
    }

    const payload = {
      deliveryDate: Date.now(),
      invoiceNumber: order.orderNumber,
      trackingCode,
      products,
    };

    try {
      const { ok, status, data } = await this.callDigipayApi({
        method: 'POST',
        path: `/purchases/deliver?type=${purchaseType}`,
        body: payload,
        operation: 'purchases/deliver',
        allowEmptyResponse: true,
      });

      const resultStatus = this.getResultStatus(data);
      const message = this.getResultMessage(
        data,
        `خطای دیجی‌پی در اعلام تحویل (${status})`,
      );

      this.mergeGatewayResponse(payment, 'delivery', {
        request: payload,
        response: data,
        sentAt: new Date().toISOString(),
      });

      if (ok && resultStatus === 0) {
        payment.digipayDeliveredAt = new Date();
        await this.paymentRepo.save(payment);

        this.logger.log(
          `✅ تحویل خرید اعتباری دیجی‌پی برای پرداخت ${payment.id} اعلام شد.`,
        );

        return { sent: true, success: true, message: 'تحویل اعلام شد' };
      }

      await this.paymentRepo.save(payment);

      this.logger.warn(
        `⚠️ اعلام تحویل دیجی‌پی برای پرداخت ${payment.id} ناتمام ماند: ${message}`,
      );

      return { sent: true, success: false, pending: true, message };
    } catch (error: any) {
      this.logger.error(
        `❌ خطا در اعلام تحویل دیجی‌پی برای پرداخت ${payment.id}`,
        error?.stack || error,
      );

      return {
        sent: false,
        success: false,
        pending: true,
        message: error?.message || 'خطا در ارتباط با دیجی‌پی برای اعلام تحویل',
      };
    }
  }

  /** اعلام تحویل همهٔ پرداخت‌های موفق اعتباریِ یک سفارش (برای ادمین) */
  async deliverOrder(orderId: number) {
    const payments = await this.paymentRepo.find({
      where: {
        orderId,
        gateway: PaymentGateway.DIGIPAY,
        status: PaymentStatus.SUCCESS,
      },
      order: { id: 'ASC' },
    });

    if (!payments.length) {
      throw new NotFoundException(
        'پرداخت موفقی از دیجی‌پی برای این سفارش نیست',
      );
    }

    const results = [] as {
      paymentId: number;
      sent: boolean;
      success: boolean;
      message: string;
    }[];

    for (const payment of payments) {
      const result = await this.deliverPurchase(payment);

      results.push({
        paymentId: payment.id,
        sent: result.sent,
        success: result.success,
        message: result.message,
      });
    }

    return results;
  }

  /**
   * اعلام تحویل سفارش‌هایی که ادمین وضعیتشان را DELIVERED کرده است.
   *
   * فیلتر در سطح دیتابیس انجام می‌شود (join با orders) تا پنجرهٔ `take` با
   * پرداخت‌های اعتباری سفارش‌های تحویل‌نشده پر نشود.
   */
  async reconcileDeliveries(limit = 20): Promise<void> {
    const payments = await this.paymentRepo
      .createQueryBuilder('payment')
      .innerJoin(Order, 'o', 'o.id = payment.orderId')
      .where('payment.gateway = :gateway', {
        gateway: PaymentGateway.DIGIPAY,
      })
      .andWhere('payment.status = :status', {
        status: PaymentStatus.SUCCESS,
      })
      .andWhere('payment.digipay_delivered_at IS NULL')
      .andWhere('payment.digipay_purchase_type IN (:...creditTypes)', {
        creditTypes: [...DIGIPAY_CREDIT_PURCHASE_TYPES],
      })
      .andWhere('payment.saleReferenceId IS NOT NULL')
      .andWhere('o.status = :orderStatus', {
        orderStatus: OrderStatus.DELIVERED,
      })
      .orderBy('payment.id', 'ASC')
      .take(limit)
      .getMany();

    for (const payment of payments) {
      await this.deliverPurchase(payment);
    }
  }

  //==============================================================
  // بازگشت خرید (Refund) و استعلام آن (Refund Inquiry)
  //==============================================================

  private async sumRefundedAmount(paymentId: number): Promise<number> {
    const refunds = await this.refundRepo.find({
      where: {
        paymentId,
        status: Not(PaymentRefundStatus.FAILED),
      },
    });

    return refunds.reduce((sum, refund) => sum + Number(refund.amount ?? 0), 0);
  }

  /**
   * ثبت درخواست عودت برای پرداخت.
   *
   * - `params.amount` به **ریال** است (پیش‌فرض: کل ماندهٔ قابل عودت) و مجموع
   *   عودت‌ها از مبلغ تراکنش بیشتر نمی‌شود (مستند: Partial Refund مجاز است
   *   ولی سقف دارد → خطای 9022).
   * - `providerId` یکتا برای هر درخواست؛ تکرار همان شناسه/داده‌ها همان ثبت
   *   قبلی را برمی‌گرداند و در استعلام قابل پیگیری است.
   * - پاسخ ۲۰۰ فقط «ثبت موفق» است؛ نتیجهٔ نهایی از Refund Inquiry می‌آید.
   */
  async refundPayment(params: {
    payment: Payment;
    amount?: number;
    reason?: string;
    customerName?: string;
  }): Promise<PaymentRefund> {
    const { payment } = params;

    if (payment.gateway !== PaymentGateway.DIGIPAY) {
      throw new BadRequestException('این پرداخت مربوط به دیجی‌پی نیست');
    }

    if (payment.status !== PaymentStatus.SUCCESS) {
      throw new BadRequestException(
        'فقط پرداخت تأییدشده (SUCCESS) قابل عودت است',
      );
    }

    const saleTrackingCode = payment.saleReferenceId?.trim();

    if (!saleTrackingCode) {
      throw new BadRequestException(
        'کد پیگیری خرید (trackingCode) برای عودت موجود نیست',
      );
    }

    const alreadyRefunded = await this.sumRefundedAmount(payment.id);
    const refundable = Number(payment.amount ?? 0) - alreadyRefunded;

    if (refundable <= 0) {
      throw new BadRequestException(
        'مبلغ این پرداخت قبلاً به‌طور کامل عودت شده است',
      );
    }

    /*
     * واحد مبلغ در این متد **ریال** است (هم‌واحد payments.amount). تبدیل
     * تومان→ریال فقط یک‌بار و در لایهٔ بیرونی (refundOrder/کنترلر) انجام می‌شود
     * تا مبلغ اشتباه به دیجی‌پی نرود.
     */
    const requestedAmount =
      params.amount === undefined
        ? refundable
        : Math.round(Number(params.amount));

    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new BadRequestException('مبلغ عودت نامعتبر است');
    }

    if (requestedAmount > refundable) {
      throw new BadRequestException(
        `مبلغ عودت از ماندهٔ قابل عودت (${refundable / 10} تومان) بیشتر است`,
      );
    }

    const refundType = this.resolveRefundType(payment);

    if (refundType === null) {
      throw new BadRequestException(
        'نوع عودت این خرید (کارت اعتباری) در مستند دیجی‌پی تعریف نشده است؛ ' +
          'نوع عودت باید با پشتیبانی دیجی‌پی هماهنگ شود',
      );
    }

    const providerId = `ZP-REF-${payment.id}-${Date.now()}`.slice(0, 100);

    const refund = this.refundRepo.create({
      paymentId: payment.id,
      gateway: payment.gateway,
      providerId,
      amount: requestedAmount,
      saleTrackingCode,
      refundType,
      status: PaymentRefundStatus.PENDING,
      attempts: 1,
      lastCheckedAt: new Date(),
    });

    const savedRefund = await this.refundRepo.save(refund);

    const body: Record<string, unknown> = {
      providerId,
      amount: requestedAmount,
      saleTrackingCode,
    };

    if (params.customerName) {
      body.customerName = params.customerName.slice(0, 100);
    }

    if (params.reason) {
      body.description = params.reason.slice(0, 200);
    }

    try {
      const { ok, status, data } = await this.callDigipayApi({
        method: 'POST',
        path: `/refunds?type=${refundType}`,
        body,
        operation: 'refunds',
        allowEmptyResponse: true,
      });

      const resultStatus = this.getResultStatus(data);
      const message = this.getResultMessage(
        data,
        `خطای دیجی‌پی در ثبت عودت (${status})`,
      );

      savedRefund.rawResponse = data;

      if (ok && resultStatus === 0) {
        savedRefund.trackingCode = this.asTrimmedString(data?.trackingCode);
        savedRefund.lastError = null;

        this.logger.log(
          `✅ درخواست عودت ${savedRefund.providerId} برای پرداخت ${payment.id} ثبت شد ` +
            `(trackingCode=${savedRefund.trackingCode || '—'})؛ نتیجهٔ نهایی با Inquiry مشخص می‌شود.`,
        );
      } else {
        const resultCode =
          resultStatus === null ? String(status) : String(resultStatus);

        savedRefund.resultCode = resultCode;
        savedRefund.lastError = message;

        if (DIGIPAY_REFUND_DEFINITE_ERROR_CODES.has(resultCode)) {
          // مستند: این خطاها یعنی درخواست جدید شکست خورده است
          savedRefund.status = PaymentRefundStatus.FAILED;
        } else {
          // نتیجه نامعلوم: درخواست مجدد نفرست (ممکن است ثبت شده باشد) و
          // فقط با Inquiry وضعیت را روشن کن.
          this.logger.warn(
            `⚠️ نتیجهٔ ثبت عودت ${savedRefund.providerId} نامشخص است (${resultCode}: ${message})؛ ` +
              'با Refund Inquiry پیگیری می‌شود.',
          );
        }
      }

      await this.refundRepo.save(savedRefund);

      return savedRefund;
    } catch (error: any) {
      // خطای شبکه/پارس: وضعیت نامعلوم است؛ رکورد PENDING می‌ماند تا Inquiry
      // مشخص کند درخواست ثبت شده یا نه.
      savedRefund.lastError =
        error?.message || 'خطا در ارتباط با دیجی‌پی برای ثبت عودت';

      await this.refundRepo.save(savedRefund);

      this.logger.error(
        `❌ خطای ارتباط در ثبت عودت ${savedRefund.providerId}: ${savedRefund.lastError}`,
      );

      return savedRefund;
    }
  }

  /**
   * عودت همهٔ پرداخت‌های موفق دیجی‌پی یک سفارش (مثلاً پس از لغو سفارش).
   * idempotent است: مبلغ‌های قبلاً عودت‌شده کسر می‌شوند.
   */
  async refundOrder(
    orderId: number,
    options: {
      /** مبلغ دلخواه برای عودت جزئی، به **تومان** (پیش‌فرض: کل مانده) */
      amount?: number;
      reason?: string;
      customerName?: string;
    } = {},
  ): Promise<{ refunds: PaymentRefund[]; messages: string[] }> {
    const requestedTotal =
      options.amount === undefined
        ? null
        : Math.round(Number(options.amount) * 10);

    if (
      requestedTotal !== null &&
      (!Number.isFinite(requestedTotal) || requestedTotal <= 0)
    ) {
      throw new BadRequestException('مبلغ عودت نامعتبر است');
    }

    let remainingRequested = requestedTotal;
    const payments = await this.paymentRepo.find({
      where: {
        orderId,
        gateway: PaymentGateway.DIGIPAY,
        status: PaymentStatus.SUCCESS,
      },
      order: { id: 'ASC' },
    });

    const refunds: PaymentRefund[] = [];
    const messages: string[] = [];

    if (!payments.length) {
      messages.push('پرداخت موفقی از دیجی‌پی برای این سفارش ثبت نشده است');
      return { refunds, messages };
    }

    for (const payment of payments) {
      if (remainingRequested !== null && remainingRequested <= 0) {
        break;
      }

      const refunded = await this.sumRefundedAmount(payment.id);
      const refundable = Number(payment.amount ?? 0) - refunded;

      if (refundable <= 0) {
        messages.push(`پرداخت ${payment.id} قبلاً به‌طور کامل عودت شده است`);
        continue;
      }

      if (!payment.saleReferenceId?.trim()) {
        messages.push(
          `پرداخت ${payment.id} کد پیگیری ندارد؛ عودت باید دستی در پنل دیجی‌پی انجام شود`,
        );
        continue;
      }

      const amountForThisPayment =
        remainingRequested === null
          ? refundable
          : Math.min(refundable, remainingRequested);

      try {
        const refund = await this.refundPayment({
          payment,
          amount: amountForThisPayment,
          reason: options.reason,
          customerName: options.customerName,
        });

        refunds.push(refund);
        messages.push(
          refund.status === PaymentRefundStatus.FAILED
            ? `ثبت عودت پرداخت ${payment.id} ناموفق بود: ${refund.lastError || refund.resultCode}`
            : `عودت پرداخت ${payment.id} ثبت شد و در حال پیگیری است`,
        );

        if (remainingRequested !== null) {
          remainingRequested -= amountForThisPayment;
        }
      } catch (error: any) {
        messages.push(
          `عودت پرداخت ${payment.id} انجام نشد: ${error?.message || error}`,
        );
      }
    }

    if (remainingRequested !== null && remainingRequested > 0) {
      messages.push(
        `بخشی از مبلغ درخواستی عودت نشد (${remainingRequested / 10} تومان)؛ ` +
          'ماندهٔ پرداخت‌ها کمتر از مبلغ درخواستی بود',
      );
    }

    return { refunds, messages };
  }

  /**
   * استعلام وضعیت نهایی یک درخواست عودت (Refund Inquiry — بند ۱۲).
   *
   * `inquiryId` می‌تواند trackingCode عودت یا همان providerId ارسالی باشد.
   */
  async inquireRefund(refund: PaymentRefund): Promise<PaymentRefund> {
    const inquiryId = refund.trackingCode?.trim() || refund.providerId;

    if (!inquiryId) {
      throw new BadRequestException('شناسهٔ عودت برای استعلام موجود نیست');
    }

    refund.attempts = (refund.attempts ?? 0) + 1;
    refund.lastCheckedAt = new Date();

    try {
      const { ok, status, data } = await this.callDigipayApi({
        method: 'GET',
        path: `/refunds/${encodeURIComponent(inquiryId)}?type=${refund.refundType}`,
        operation: 'refunds/inquiry',
        allowEmptyResponse: true,
      });

      const resultStatus = this.getResultStatus(data);
      const message = this.getResultMessage(
        data,
        `خطای دیجی‌پی در استعلام عودت (${status})`,
      );

      refund.rawResponse = data;

      if (!ok || resultStatus !== 0) {
        refund.lastError = message;

        /*
         * 1121 در Inquiry یعنی «عودت یافت نشد» → می‌توان پس از رفع علت دوباره
         * اقدام کرد، پس رکورد FAILED می‌شود تا ماندهٔ قابل عودت آزاد بماند.
         */
        if (String(resultStatus) === '1121' || status === 404) {
          refund.status = PaymentRefundStatus.FAILED;
          refund.resultCode = '1121';
        }

        await this.refundRepo.save(refund);
        return refund;
      }

      const refundStatus = Number(data?.status);
      refund.trackingCode =
        this.asTrimmedString(data?.trackingCode) || refund.trackingCode;
      refund.resultCode = this.asTrimmedString(data?.resultCode) || null;
      refund.lastError = null;

      const destinationType = Number(data?.destinationType);

      if (Number.isFinite(destinationType)) {
        refund.destinationType = destinationType;
      }

      const transferDate = Number(data?.transferDate);

      if (Number.isFinite(transferDate) && transferDate > 0) {
        refund.transferDate = String(transferDate);
      }

      if (refundStatus === DIGIPAY_REFUND_INQUIRY_STATUS.SUCCESS) {
        refund.status = PaymentRefundStatus.SUCCESS;

        this.logger.log(
          `✅ عودت ${refund.providerId} (پرداخت ${refund.paymentId}) با موفقیت انجام شد.`,
        );
      } else if (refundStatus === DIGIPAY_REFUND_INQUIRY_STATUS.FAILED) {
        refund.status = PaymentRefundStatus.FAILED;
        refund.lastError = 'عودت توسط دیجی‌پی ناموفق اعلام شد';
      }

      await this.refundRepo.save(refund);

      return refund;
    } catch (error: any) {
      refund.lastError =
        error?.message || 'خطا در ارتباط با دیجی‌پی برای استعلام عودت';

      await this.refundRepo.save(refund);

      this.logger.error(
        `❌ خطا در استعلام عودت ${refund.providerId}: ${refund.lastError}`,
      );

      return refund;
    }
  }

  /**
   * کارهای دوره‌ای عودت:
   * ۱. عودت خودکار وجه پرداخت‌های دیجی‌پی سفارش‌های لغوشده
   * ۲. استعلام درخواست‌های عودت معلق
   */
  async reconcileRefunds(limit = 20): Promise<void> {
    if (this.isAutoRefundEnabled()) {
      await this.autoRefundCancelledOrders(limit);
    }

    const staleCutoff = new Date(Date.now() - 2 * 60_000);

    const pendingRefunds = await this.refundRepo.find({
      where: {
        status: PaymentRefundStatus.PENDING,
        lastCheckedAt: LessThan(staleCutoff),
      },
      take: limit,
      order: { lastCheckedAt: 'ASC' },
    });

    for (const refund of pendingRefunds) {
      await this.inquireRefund(refund);
    }
  }

  /**
   * پرداخت‌هایی که باید عودت شوند: خرید موفق دیجی‌پی روی سفارش **لغوشده** که
   * مجموع عودت‌های غیرناموفقش از مبلغ پرداخت کمتر است.
   *
   * چرا QueryBuilder؟ اگر همهٔ پرداخت‌های موفق را می‌گرفتیم و در JS فیلتر
   * می‌کردیم، پنجرهٔ `take` با پرداخت‌های سفارش‌های لغوشده یا قبلاً عودت‌شده پر
   * می‌شد و سفارش‌های قدیمی‌تر هرگز به نوبت نمی‌رسیدند.
   */
  private async findPaymentsNeedingRefund(limit: number): Promise<Payment[]> {
    return this.paymentRepo
      .createQueryBuilder('payment')
      .innerJoin(Order, 'o', 'o.id = payment.orderId')
      .where('payment.gateway = :gateway', {
        gateway: PaymentGateway.DIGIPAY,
      })
      .andWhere('payment.status = :status', {
        status: PaymentStatus.SUCCESS,
      })
      .andWhere('o.status = :orderStatus', {
        orderStatus: OrderStatus.CANCELLED,
      })
      .andWhere(
        `(SELECT COALESCE(SUM(r.amount), 0) FROM payment_refunds r
          WHERE r.payment_id = payment.id AND r.status <> :failedRefundStatus) < payment.amount`,
        { failedRefundStatus: PaymentRefundStatus.FAILED },
      )
      .andWhere('payment.saleReferenceId IS NOT NULL')
      .orderBy('payment.id', 'ASC')
      .take(limit)
      .getMany();
  }

  private async autoRefundCancelledOrders(limit: number): Promise<void> {
    const payments = await this.findPaymentsNeedingRefund(limit);

    if (!payments.length) {
      return;
    }

    const orderIds = [
      ...new Set(
        payments
          .map(payment => payment.orderId)
          .filter((id): id is number => typeof id === 'number'),
      ),
    ];

    for (const orderId of orderIds) {
      const { messages } = await this.refundOrder(orderId, {
        reason: 'لغو سفارش در فروشگاه زوپینی',
      });

      for (const message of messages) {
        this.logger.log(`ℹ️ ${message}`);
      }
    }
  }

  /** فهرست عودت‌های یک پرداخت (برای ادمین) */
  async listRefunds(paymentId?: number): Promise<PaymentRefund[]> {
    return this.refundRepo.find({
      where: paymentId ? { paymentId } : {},
      order: { id: 'DESC' },
      take: 100,
    });
  }

  async findRefundById(refundId: number): Promise<PaymentRefund> {
    const refund = await this.refundRepo.findOne({ where: { id: refundId } });

    if (!refund) {
      throw new NotFoundException('درخواست عودت یافت نشد');
    }

    return refund;
  }

  /** استعلام/تأیید دستی یک پرداخت دیجی‌پی (همان مسیری که کرون می‌رود) */
  async reconcilePaymentById(
    paymentId: number,
  ): Promise<DigipayOperationResult> {
    const payment = await this.paymentRepo.findOne({
      where: { id: paymentId, gateway: PaymentGateway.DIGIPAY },
    });

    if (!payment) {
      throw new NotFoundException('پرداخت دیجی‌پی یافت نشد');
    }

    return this.verifyPayment(payment);
  }

  //==============================================================
  // شکست پرداخت
  //==============================================================

  /** برای callback شکست‌خوردهٔ مستند، پرداخت و موجودی/سفارش را همگام می‌کند. */
  async failPayment(
    payment: Payment,
    resCode = 'FAILURE',
    callback?: DigipayCallbackData,
  ): Promise<DigipayOperationResult> {
    return this.markPaymentFailed(
      payment,
      resCode,
      'پرداخت دیجی‌پی ناموفق بود',
      callback,
    );
  }

  private async markPaymentFailed(
    payment: Payment,
    resCode: string,
    message: string,
    callback?: DigipayCallbackData,
  ): Promise<DigipayOperationResult> {
    if (callback) {
      this.applyCallbackData(payment, callback);
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      return {
        success: true,
        pending: false,
        message: 'پرداخت قبلاً با موفقیت ثبت شده است',
        orderId: payment.orderId ?? undefined,
      };
    }

    payment.status = PaymentStatus.FAILED;
    payment.resCode = resCode;
    await this.paymentRepo.save(payment);

    try {
      if (payment.purpose === PaymentPurpose.ORDER) {
        await this.ordersService.failOrderPayment(payment.orderId!);
      } else {
        await this.walletChargeService.markChargeFailed(payment);
      }
    } catch (error) {
      // callback نباید به خاطر خطای ثانویهٔ ثبت سفارش ۵۰۰ شود؛ پرداخت در
      // دیتابیس FAILED است و خطا برای بررسی دستی لاگ می‌شود.
      this.logger.error(
        `❌ همگام‌سازی وضعیت پس از شکست پرداخت دیجی‌پی ${payment.id} ناموفق بود`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return {
      success: false,
      pending: false,
      message,
      orderId: payment.orderId ?? undefined,
    };
  }

  private async finalizeSuccessfulPayment(
    payment: Payment,
  ): Promise<DigipayOperationResult> {
    if (payment.purpose === PaymentPurpose.WALLET_CHARGE) {
      try {
        await this.walletChargeService.settleCharge(payment);
      } catch (error) {
        this.logger.error(
          `❌ پرداخت دیجی‌پی ${payment.id} موفق بود ولی شارژ کیف پول ` +
            `(${payment.walletChargeId}) انجام نشد؛ پرداخت SUCCESS باقی می‌ماند`,
          error instanceof Error ? error.stack : String(error),
        );
      }

      return {
        success: true,
        pending: false,
        message: 'پرداخت با موفقیت انجام شد',
        orderId: payment.orderId ?? undefined,
      };
    }

    try {
      const order = await this.ordersService.findOneForAdmin(payment.orderId!);

      if (order.status === OrderStatus.PENDING) {
        await this.ordersService.confirmOrderPayment(payment.orderId!);
      }

      /*
       * اگر سفارش پیش‌تر توسط ادمین «تحویل‌شده» شده باشد (مثلاً پرداخت
       * اعتباری با callback دیررس در سفارش حضوری)، تحویل را همان‌جا اعلام
       * می‌کنیم تا منتظر کرون نمانیم.
       */
      if (order.status === OrderStatus.DELIVERED) {
        await this.deliverPurchase(payment);
      }
    } catch (error) {
      /*
       * خطای شبکه/نامشخص: وضعیت واقعی تراکنش معلوم نیست.
       * پرداخت را FAILED نمی‌کنیم و سفارش را لغو نمی‌کنیم
       * تا بررسی مجدد یا دستی ممکن باشد.
       * (خطای قطعی درگاه با return در بدنه try مدیریت شده است)
       */
      this.logger.error(
        `❌ پرداخت دیجی‌پی ${payment.id} موفق بود ولی ثبت نهایی سفارش ` +
          `${payment.orderId} خطا خورد؛ پرداخت SUCCESS باقی می‌ماند`,
        error instanceof Error ? error.stack : String(error),
      );

      return {
        success: true,
        pending: false,
        message: 'پرداخت دریافت شد؛ ثبت نهایی سفارش به‌زودی انجام می‌شود',
        orderId: payment.orderId ?? undefined,
      };
    }

    return {
      success: true,
      pending: false,
      message: 'پرداخت با موفقیت انجام شد',
      orderId: payment.orderId ?? undefined,
    };
  }

  private pendingResult(
    payment: Payment,
    message: string,
  ): DigipayOperationResult {
    return {
      success: false,
      pending: true,
      message,
      orderId: payment.orderId ?? undefined,
    };
  }

  private amountMatches(value: unknown, expected: unknown): boolean {
    const received = Number(value);
    const target = Number(expected);

    return (
      Number.isFinite(received) &&
      Number.isFinite(target) &&
      received > 0 &&
      received === target
    );
  }

  private asTrimmedString(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    return '';
  }

  private normalizeResult(value: unknown): string {
    return this.asTrimmedString(value).toUpperCase();
  }

  /**
   * نرمال‌سازی «نوع خرید» (type).
   *
   * نکتهٔ مهم: `Number(null)` صفر است و ۰ خودش یک نوع خرید معتبر (IPG) است؛
   * اگر null را صفر حساب کنیم، پرداخت بدون نوع به‌اشتباه «اینترنتی» فرض و با
   * `type=0` verify می‌شود. پس null/undefined/رشتهٔ خالی صریحاً رد می‌شوند.
   */
  private normalizeTicketType(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const type = Number(value);

    if (!Number.isInteger(type) || !DIGIPAY_VERIFY_TICKET_TYPES.has(type)) {
      return null;
    }

    return type;
  }

  private getStoredCallback(payment: Payment): DigipayCallbackData {
    const response = payment.gatewayResponse;
    const callback =
      response &&
      typeof response === 'object' &&
      !Array.isArray(response) &&
      response.callback &&
      typeof response.callback === 'object'
        ? response.callback
        : null;

    return callback ? (callback as DigipayCallbackData) : {};
  }

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
