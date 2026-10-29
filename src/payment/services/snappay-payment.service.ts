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
import { In, LessThan, MoreThan, Not, Repository } from 'typeorm';

import {
  SnappayAdminCancelDto,
  SnappayAdminUpdateDto,
} from '../dto/snappay-admin.dto';
import { SnappayEligibilityDto } from '../dto/snappay-eligibility.dto';
import {
  Payment,
  PaymentGateway,
  PaymentPurpose,
  PaymentStatus,
} from '../entities/payment.entity';
import {
  SnappPayClient,
  SnappPayError,
  SnappPayMethod,
  SnappPayStatus,
} from '../snappay/snappay.client';
import {
  buildSnappPayCart,
  buildSnappPayUpdateCart,
  BuiltSnappPayCart,
  generateSnappPayTransactionId,
} from '../snappay/snappay-cart.util';
import { PaymentGuardService } from './payment-guard.service';

export interface SnappayEligibilityResult {
  eligible: boolean;
  title_message?: string;
  description?: string;
}

export interface SnappayCallbackData {
  transactionId: string;
  state: string;
  amount: string;
}

type SnappayOperationResult = {
  success: boolean;
  pending?: boolean;
  message: string;
  orderId?: number;
};

type SnappayStatusResponse = {
  transactionId: string;
  status: SnappPayStatus;
  amount: number;
};

const SNAPPAY_METHODS: SnappPayMethod[] = [
  'POSTPAID',
  'INSTALLMENT',
  'FINANCING',
];

/** توکن پرداختِ بدون callback بعد از این مدت منقضی در نظر گرفته می‌شود */
const SNAPPAY_ABANDONED_TOKEN_HOURS = 24;

/**
 * درگاه اسنپ‌پی (REST API ویرایش ۲٫۱).
 *
 * روند طبق مستند:
 *   eligibility ← نمایش روش پرداخت فقط در صورت eligible=true و با همان
 *                 عنوان/توضیح داینامیک اسنپ‌پی
 *   token       ← ساخت توکن پرداخت و هدایت کاربر به paymentPageUrl
 *   callback    ← POST شدن transactionId/state/amount به returnURL
 *   verify      ← فقط یک‌بار مؤثر؛ در timeout با status تصمیم گرفته می‌شود
 *   settle      ← نهایی‌سازی؛ سفارش فقط بعد از settle موفق تأیید می‌شود
 *   status      ← مرجع بازیابی در همهٔ حالت‌های نامشخص (timeout، crash،
 *                 callback تکراری)؛ هیچ خطای شبکه‌ای پرداخت را FAILED نمی‌کند
 *
 * نگاشت روی جدول payments موجود (بدون ستون جدید):
 *   providerId = transactionId ما (کلید callback)
 *   refId      = paymentToken اسنپ‌پی (قبل از دریافت توکن موقتاً همان
 *                transactionId است تا رکورد تلاش پرداخت از ابتدا ماندگار باشد)
 *   amount     = مبلغ به ریال
 *   وضعیت‌ها:  PENDING ← توکن ساخته شده/در انتظار verify
 *              VERIFIED ← سمت اسنپ‌پی verify شده، settle مانده
 *              SUCCESS ← settle شده (عمداً SUCCESS است نه SETTLED تا گارد
 *                        پرداخت، خلاصهٔ پرداخت ادمین و بقیهٔ سیستم مثل
 *                        سایر درگاه‌ها رفتار کنند؛ وضعیت اسنپ‌پی در resCode
 *                        و gatewayResponse.snappay.status ثبت می‌شود)
 *              FAILED ← شکست قطعی (CANCEL/REVERT سمت اسنپ‌پی یا callback
 *                        ناموفق همراه با revert)
 *
 * شارژ کیف پول با اسنپ‌پی عمداً پشتیبانی نمی‌شود؛ اسنپ‌پی اعتبار خرید
 * کالاست و cartList الزامی دارد.
 */
@Injectable()
export class SnappayPaymentService {
  private readonly logger = new Logger(SnappayPaymentService.name);

  private client?: SnappPayClient;

  /** قفل درون‌پردازه‌ای هر پرداخت؛ callback تکراری/هم‌زمان verify دوم نمی‌سازد */
  private readonly paymentLocks = new Map<number, Promise<void>>();

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    private readonly ordersService: OrdersService,
    private readonly paymentGuard: PaymentGuardService,
  ) {}

  // =========================================================
  // پیکربندی
  // =========================================================

  private getConfig(name: string): string {
    return this.configService.get<string>(name)?.trim() ?? '';
  }

  /**
   * اسنپ‌پی فقط وقتی فعال است که هم سوییچ SNAPPAY_ENABLED=true باشد و هم
   * همهٔ اطلاعات دسترسی تنظیم شده باشند؛ در غیر این صورت eligibility
   * مقدار false برمی‌گرداند و این روش پرداخت اصلاً در سایت نمایش داده
   * نمی‌شود (رفتار سایت دقیقاً مثل قبل می‌ماند).
   */
  isEnabled(): boolean {
    return (
      this.getConfig('SNAPPAY_ENABLED') === 'true' &&
      Boolean(this.getConfig('SNAPPAY_API_URL')) &&
      Boolean(this.getConfig('SNAPPAY_CLIENT_ID')) &&
      Boolean(this.getConfig('SNAPPAY_CLIENT_SECRET')) &&
      Boolean(this.getConfig('SNAPPAY_USERNAME')) &&
      Boolean(this.getConfig('SNAPPAY_PASSWORD')) &&
      Boolean(
        this.getConfig('SNAPPAY_CALLBACK_URL') || this.getConfig('APP_URL'),
      )
    );
  }

  private getClient(): SnappPayClient {
    if (this.client) {
      return this.client;
    }

    if (!this.isEnabled()) {
      throw new BadRequestException('درگاه اسنپ‌پی در حال حاضر فعال نیست');
    }

    try {
      this.client = new SnappPayClient({
        baseUrl: this.getConfig('SNAPPAY_API_URL'),
        clientId: this.getConfig('SNAPPAY_CLIENT_ID'),
        clientSecret: this.getConfig('SNAPPAY_CLIENT_SECRET'),
        username: this.getConfig('SNAPPAY_USERNAME'),
        password: this.getConfig('SNAPPAY_PASSWORD'),
      });
    } catch (error) {
      this.logger.error(
        '❌ پیکربندی اسنپ‌پی نامعتبر است',
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadRequestException('درگاه اسنپ‌پی در حال حاضر فعال نیست');
    }

    return this.client;
  }

  /**
   * محدود کردن روش‌های پرداخت (اختیاری؛ SNAPPAY_PAYMENT_METHOD_TYPES).
   * طبق مستند اگر ارسال نشود کاربر همهٔ روش‌های فعال خودش را می‌بیند و
   * ارسال آن در درخواست توکن فقط وقتی اثر دارد که تیم اسنپ‌پی برای
   * پذیرنده فعالش کرده باشد.
   */
  private getPaymentMethodTypes(): SnappPayMethod[] | undefined {
    const methods = this.getConfig('SNAPPAY_PAYMENT_METHOD_TYPES')
      .split(',')
      .map(value => value.trim().toUpperCase())
      .filter((value): value is SnappPayMethod =>
        SNAPPAY_METHODS.includes(value as SnappPayMethod),
      );

    return methods.length ? methods : undefined;
  }

  private getDefaultCategory(): string {
    return this.getConfig('SNAPPAY_DEFAULT_CATEGORY') || 'پوشاک';
  }

  private getCommissionType(): number {
    const parsed = Number(this.getConfig('SNAPPAY_DEFAULT_COMMISSION_TYPE'));

    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 100;
  }

  /**
   * آدرس بازگشت (returnURL)؛ دامنهٔ آن باید همان دامنه‌ای باشد که هنگام
   * تعریف پذیرنده به اسنپ‌پی معرفی و whitelist شده است، وگرنه درخواست
   * توکن رد می‌شود. نتیجه با POST به این آدرس برمی‌گردد.
   */
  private getCallbackUrl(): string {
    const explicit = this.getConfig('SNAPPAY_CALLBACK_URL');

    if (explicit) {
      return explicit;
    }

    const appUrl = this.getConfig('APP_URL');

    if (!appUrl) {
      throw new BadRequestException(
        'SNAPPAY_CALLBACK_URL یا APP_URL تنظیم نشده است',
      );
    }

    return `${appUrl.replace(/\/+$/, '')}/api/payment/callback/snappay`;
  }

  // =========================================================
  // eligibility
  // =========================================================

  /**
   * بررسی امکان پرداخت؛ پاسخ (عنوان/توضیح) بدون هیچ تغییری به فرانت
   * داده می‌شود تا دقیقاً همان‌طور که اسنپ‌پی خواسته نمایش داده شود.
   * هر خطایی اینجا یعنی «نمایش نده» (eligible=false) تا چک‌اوت هرگز به
   * خاطر اسنپ‌پی خراب نشود؛ شروع واقعی پرداخت دوباره و با مبلغ دقیق
   * سفارش همین بررسی را تکرار می‌کند.
   */
  async getEligibility(
    userId: number,
    dto: SnappayEligibilityDto,
  ): Promise<SnappayEligibilityResult> {
    if (!this.isEnabled()) {
      return { eligible: false };
    }

    let amount: number;

    if (dto.orderId) {
      const order = await this.ordersService.findOneForPayment(
        dto.orderId,
        userId,
      );

      try {
        amount = this.buildCartFromOrder(order).amount;
      } catch (error) {
        this.logger.warn(
          `eligibility اسنپ‌پی برای سفارش ${dto.orderId} ممکن نیست: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        return { eligible: false };
      }
    } else if (dto.amount) {
      amount = dto.amount;
    } else {
      throw new BadRequestException(
        'برای بررسی اسنپ‌پی مبلغ (amount) یا شناسه سفارش (orderId) لازم است',
      );
    }

    try {
      const result = await this.getClient().eligible(
        amount,
        this.getPaymentMethodTypes(),
      );

      return {
        eligible: result.eligible,
        title_message: result.title_message,
        description: result.description,
      };
    } catch (error) {
      this.logger.error(
        `❌ eligibility اسنپ‌پی برای مبلغ ${amount} ریال ناموفق بود؛ روش پرداخت نمایش داده نمی‌شود`,
        error instanceof Error ? error.stack : String(error),
      );
      return { eligible: false };
    }
  }

  // =========================================================
  // شروع پرداخت: ساخت توکن
  // =========================================================

  async requestPayment(
    orderId: number,
    userId: number,
  ): Promise<{ refId: string; payUrl: string }> {
    const client = this.getClient();

    const order = await this.ordersService.findOneForPayment(orderId, userId);

    if (!order) {
      throw new BadRequestException('سفارش یافت نشد');
    }

    // سفارش باید PENDING باشد و پرداخت باز دیگری نداشته باشد (گارد مشترک همهٔ درگاه‌ها)
    await this.paymentGuard.ensureOrderPayable(order);

    let built: ReturnType<typeof this.buildCartFromOrder>;

    try {
      built = this.buildCartFromOrder(order);
    } catch (error) {
      this.logger.error(
        `❌ ساخت سبد اسنپ‌پی برای سفارش ${orderId} ممکن نیست`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadRequestException(
        'امکان پرداخت این سفارش با اسنپ‌پی وجود ندارد',
      );
    }

    const mobile = String(normalizeIranMobile(order.user?.phone ?? ''));

    if (!isIranMobile(mobile)) {
      throw new BadRequestException(
        'شماره همراه معتبری برای پرداخت اسنپ‌پی ثبت نشده است',
      );
    }

    const methods = this.getPaymentMethodTypes();

    // تکرار eligibility با مبلغ واقعی و سمت سرور (نمایش فرانت کافی نیست)
    let eligibility: SnappayEligibilityResult;

    try {
      eligibility = await client.eligible(built.amount, methods);
    } catch (error) {
      this.logger.error(
        `❌ eligibility اسنپ‌پی هنگام شروع پرداخت سفارش ${orderId} ناموفق بود`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadRequestException('خطا در ارتباط با درگاه اسنپ‌پی');
    }

    if (!eligibility.eligible) {
      throw new BadRequestException(
        'پرداخت اسنپ‌پی برای این مبلغ در دسترس نیست',
      );
    }

    const transactionId = generateSnappPayTransactionId(orderId);
    const purchase = {
      amount: built.amount,
      cartList: built.cartList,
      discountAmount: built.discountAmount,
      externalSourceAmount: built.externalSourceAmount,
      mobile,
      returnURL: this.getCallbackUrl(),
      transactionId,
      ...(methods?.length ? { forcedPaymentMethodTypes: methods } : {}),
    };

    /*
     * رکورد تلاش پرداخت «قبل» از فراخوانی سرویس توکن ذخیره می‌شود تا هر
     * تلاشی از ابتدا transactionId ماندگار داشته باشد. تا وقتی توکن
     * برنگشته refId موقتاً همان transactionId است؛ کاربر هنوز آدرس
     * پرداختی نگرفته، پس callbackای هم در این بازه نمی‌تواند برسد.
     */
    const payment = this.paymentRepo.create({
      orderId,
      purpose: PaymentPurpose.ORDER,
      walletChargeId: null,
      refId: transactionId,
      providerId: transactionId,
      amount: built.amount,
      gateway: PaymentGateway.SNAPPAY,
      status: PaymentStatus.PENDING,
      resCode: 'PENDING',
      gatewayResponse: {
        snappay: {
          transactionId,
          status: 'PENDING',
          eligibility,
          purchase: {
            amount: built.amount,
            cartList: built.cartList,
            discountAmount: built.discountAmount,
            externalSourceAmount: built.externalSourceAmount,
            transactionId,
          },
        },
      },
    });
    await this.paymentRepo.save(payment);

    let token: { paymentToken: string; paymentPageUrl: string };

    try {
      token = await client.createPayment(purchase);
    } catch (error) {
      if (error instanceof SnappPayError && error.kind === 'provider') {
        // اسنپ‌پی صراحتاً درخواست را رد کرده است (مثلاً returnURL نامعتبر)
        payment.status = PaymentStatus.FAILED;
        payment.resCode = error.providerCode ?? 'PROVIDER_ERROR';
        this.setMeta(payment, { tokenError: error.message });
        await this.paymentRepo.save(payment);

        this.logger.error(
          `❌ ساخت توکن اسنپ‌پی برای سفارش ${orderId} رد شد: ${error.message}`,
        );
        throw new BadRequestException('خطا در دریافت توکن پرداخت اسنپ‌پی');
      }

      /*
       * timeout/پاسخ نامفهوم: ممکن است توکن سمت اسنپ‌پی ساخته شده باشد
       * ولی ما آن را نداریم. کاربر آدرس پرداخت نگرفته و پولی پرداخت
       * نشده؛ رکورد PENDING می‌ماند تا قابل ردیابی باشد و تلاش بعدی
       * کاربر آن را (مثل بقیهٔ درگاه‌ها) STALE می‌کند.
       */
      this.setMeta(payment, {
        tokenRequestUnknown: true,
        tokenError:
          error instanceof Error ? error.message : 'ارتباط نامشخص با اسنپ‌پی',
      });
      await this.paymentRepo.save(payment);

      this.logger.error(
        `❌ نتیجهٔ ساخت توکن اسنپ‌پی برای سفارش ${orderId} نامشخص ماند (پرداخت ${payment.id})`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadRequestException(
        'نتیجهٔ درخواست پرداخت اسنپ‌پی مشخص نشد؛ مبلغی کسر نشده است. لطفاً دوباره تلاش کنید',
      );
    }

    payment.refId = token.paymentToken;
    this.setMeta(payment, { paymentToken: token.paymentToken });
    await this.paymentRepo.save(payment);

    return { refId: token.paymentToken, payUrl: token.paymentPageUrl };
  }

  private buildCartFromOrder(order: Order): BuiltSnappPayCart {
    const defaultCategory = this.getDefaultCategory();

    return buildSnappPayCart({
      orderId: order.id,
      lines: (order.items ?? []).map(item => {
        const product = item.variant?.product;
        const variantLabel = [
          item.variant?.color?.name,
          item.variant?.size?.name,
        ]
          .map(value => String(value ?? '').trim())
          .filter(Boolean)
          .join(' / ');
        const title = product?.title?.trim() || 'محصول';

        return {
          id: item.id,
          name: variantLabel ? `${title} (${variantLabel})` : title,
          category: product?.categories?.[0]?.name?.trim() || defaultCategory,
          unitPriceToman: Number(item.originalPrice ?? item.price),
          quantity: Number(item.quantity),
        };
      }),
      shippingToman: Number(order.shippingCost ?? 0),
      discountToman: Number(order.discount ?? 0),
      externalToman: Number(order.walletPayment ?? 0),
      expectedPayableToman:
        Number(order.finalPrice ?? 0) - Number(order.walletPayment ?? 0),
      commissionType: this.getCommissionType(),
    });
  }

  // =========================================================
  // callback
  // =========================================================

  async findPaymentByTransactionId(
    transactionId: string,
  ): Promise<Payment | null> {
    const normalized = transactionId?.trim();

    if (!normalized) {
      return null;
    }

    return this.paymentRepo.findOne({
      where: { providerId: normalized, gateway: PaymentGateway.SNAPPAY },
    });
  }

  async findPaymentByRefId(refId: string): Promise<Payment | null> {
    return this.paymentRepo.findOne({
      where: { refId, gateway: PaymentGateway.SNAPPAY },
    });
  }

  /**
   * پردازش نتیجهٔ بازگشتی از اسنپ‌پی.
   *
   * خود callback به‌تنهایی سند پرداخت نیست؛ فقط «مدرک اولیه» است و در
   * دیتابیس ثبت می‌شود. سند نهایی پاسخ verify/settle/status سمت سرور
   * اسنپ‌پی است، پس جعل POST به‌تنهایی سفارشی را پرداخت‌شده نمی‌کند.
   */
  async handleCallback(
    payment: Payment,
    callback: SnappayCallbackData,
  ): Promise<SnappayOperationResult> {
    return this.withPaymentLock(payment.id, async () => {
      const fresh = (await this.reloadPayment(payment.id)) ?? payment;

      await this.recordCallback(fresh, callback);

      const callbackAmount = Number(callback.amount);

      if (
        callback.amount?.trim() &&
        (!Number.isFinite(callbackAmount) ||
          callbackAmount !== Number(fresh.amount))
      ) {
        this.logger.error(
          `❌ مبلغ callback اسنپ‌پی برای پرداخت ${fresh.id} با مبلغ ثبت‌شده نمی‌خواند: ` +
            `expected=${fresh.amount}, received=${callback.amount}`,
        );
        return this.pendingResult(
          fresh,
          'مبلغ تراکنش با مبلغ سفارش مطابقت ندارد؛ تراکنش در حال بررسی است',
        );
      }

      const state = callback.state?.trim().toUpperCase();

      if (state === 'OK') {
        return this.advanceLocked(fresh);
      }

      if (state === 'FAILED') {
        return this.handleFailedCallbackLocked(fresh);
      }

      this.logger.warn(
        `callback اسنپ‌پی برای پرداخت ${fresh.id} با state ناشناخته رسید: ${callback.state || 'خالی'}`,
      );
      return this.pendingResult(fresh, 'نتیجهٔ پرداخت اسنپ‌پی مشخص نیست');
    });
  }

  private async recordCallback(
    payment: Payment,
    callback: SnappayCallbackData,
  ): Promise<void> {
    const receivedAt = new Date().toISOString();
    const state = callback.state?.trim().toUpperCase();

    this.setMeta(payment, {
      callback: { ...callback, receivedAt },
      ...(state === 'OK' ? { callbackOk: { ...callback, receivedAt } } : {}),
    });

    /*
     * احیای تلاش STALE: گارد مشترک هنگام شروع پرداخت جدید، تلاش‌های باز
     * قبلی را FAILED/STALE می‌کند. اگر کاربر همان تلاش قبلی را در تب
     * دیگری واقعاً پرداخته باشد (سناریوی صریح مستند اسنپ‌پی) callback
     * موفق آن می‌رسد؛ این پرداخت نباید به خاطر STALE بودن گم شود.
     */
    if (
      state === 'OK' &&
      payment.status === PaymentStatus.FAILED &&
      payment.resCode === 'STALE'
    ) {
      payment.status = PaymentStatus.PENDING;
      payment.resCode = 'PENDING';
      this.setMeta(payment, { revivedFromStaleAt: receivedAt });

      this.logger.warn(
        `پرداخت اسنپ‌پی ${payment.id} که STALE شده بود با callback موفق احیا شد و بررسی می‌شود.`,
      );
    }

    await this.paymentRepo.save(payment);
  }

  private async handleFailedCallbackLocked(
    payment: Payment,
  ): Promise<SnappayOperationResult> {
    if (payment.status === PaymentStatus.SUCCESS) {
      return this.successResult(payment, 'پرداخت قبلاً با موفقیت ثبت شده است');
    }

    if (payment.status === PaymentStatus.FAILED) {
      return {
        success: false,
        pending: false,
        message: 'پرداخت ناموفق بود',
        orderId: payment.orderId ?? undefined,
      };
    }

    const token = this.getPaymentToken(payment);

    if (!token) {
      return this.markFailedLocked(payment, 'FAILED', true);
    }

    const client = this.getClient();
    const providerStatus = await this.tryStatus(client, payment);

    // اگر سمت اسنپ‌پی پول گرفته شده، callback ناموفق را باور نمی‌کنیم
    if (providerStatus?.status === 'SETTLE') {
      return this.markSettledLocked(payment);
    }

    if (providerStatus?.status === 'VERIFY') {
      payment.status = PaymentStatus.VERIFIED;
      await this.paymentRepo.save(payment);
      return this.settleStepLocked(payment, client);
    }

    if (
      providerStatus?.status === 'CANCEL' ||
      providerStatus?.status === 'REVERT'
    ) {
      return this.markFailedLocked(payment, providerStatus.status, true);
    }

    /*
     * state=FAILED طبق مستند یعنی خرید ناموفق بوده و باید revert شود تا
     * اگر وجهی از کاربر کسر شده برگردد. revert تلاشِ بهینه (best effort)
     * است: اگر وضعیت از اسنپ‌پی PENDING استعلام شده باشد، نتیجهٔ ناموفق
     * قطعی است و مثل بقیهٔ درگاه‌ها سفارش لغو می‌شود؛ اگر هیچ پاسخی از
     * اسنپ‌پی نگرفته‌ایم، پرداخت PENDING می‌ماند تا scheduler تعیین
     * تکلیفش کند (وجهِ verifyنشده طبق مستند خودکار برمی‌گردد).
     */
    let reverted = false;

    try {
      const result = await client.revert(token);

      if (result.transactionId !== payment.providerId) {
        this.logger.error(
          `❌ transactionId پاسخ revert اسنپ‌پی برای پرداخت ${payment.id} مطابقت ندارد`,
        );
        return this.pendingResult(
          payment,
          'نتیجهٔ برگشت وجه اسنپ‌پی مشخص نیست',
        );
      }

      reverted = true;
      this.setMeta(payment, {
        revert: {
          transactionId: result.transactionId,
          at: new Date().toISOString(),
        },
        status: 'REVERT',
      });
    } catch (error) {
      this.logger.warn(
        `revert اسنپ‌پی برای پرداخت ${payment.id} پس از callback ناموفق کامل نشد: ` +
          (error instanceof Error ? error.message : String(error)),
      );

      const recheck = await this.tryStatus(client, payment);

      if (recheck?.status === 'SETTLE') {
        return this.markSettledLocked(payment);
      }

      if (recheck?.status === 'VERIFY') {
        payment.status = PaymentStatus.VERIFIED;
        await this.paymentRepo.save(payment);
        return this.settleStepLocked(payment, client);
      }

      if (recheck?.status === 'CANCEL' || recheck?.status === 'REVERT') {
        return this.markFailedLocked(payment, recheck.status, true);
      }

      if (!providerStatus && !recheck) {
        return this.pendingResult(
          payment,
          'نتیجهٔ پرداخت اسنپ‌پی هنوز مشخص نیست؛ تراکنش در حال بررسی است',
        );
      }
    }

    return this.markFailedLocked(payment, reverted ? 'REVERT' : 'FAILED', true);
  }

  // =========================================================
  // موتور پیش‌برد تراکنش: status ← verify ← settle
  // =========================================================

  /** ورود عمومی برای scheduler و استعلام دستی ادمین (با قفل پرداخت) */
  async advancePayment(payment: Payment): Promise<SnappayOperationResult> {
    return this.withPaymentLock(payment.id, async () => {
      const fresh = (await this.reloadPayment(payment.id)) ?? payment;

      return this.advanceLocked(fresh);
    });
  }

  private async advanceLocked(
    payment: Payment,
  ): Promise<SnappayOperationResult> {
    if (payment.purpose !== PaymentPurpose.ORDER || !payment.orderId) {
      return this.pendingResult(payment, 'این پرداخت مربوط به سفارش نیست');
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      return this.finalizeOrderLocked(payment);
    }

    if (payment.status === PaymentStatus.FAILED) {
      return {
        success: false,
        pending: false,
        message: 'پرداخت قبلاً ناموفق ثبت شده است',
        orderId: payment.orderId ?? undefined,
      };
    }

    const token = this.getPaymentToken(payment);

    if (!token) {
      return this.pendingResult(
        payment,
        'توکن پرداخت اسنپ‌پی برای این تلاش ثبت نشده است',
      );
    }

    const client = this.getClient();

    /*
     * اول status: همین یک استعلام، callback تکراری و crash وسط verify یا
     * settle را بی‌خطر می‌کند (اگر سمت اسنپ‌پی VERIFY/SETTLE شده باشد
     * دیگر verify دوم صدا زده نمی‌شود). اگر استعلام هم نامشخص بود و
     * callback موفق ثبت شده، طبق روند اصلی مستند verify تلاش می‌شود.
     */
    const providerStatus = await this.tryStatus(client, payment);

    const duplicate = await this.isDuplicateForOrder(payment);

    if (duplicate) {
      return this.handleDuplicateLocked(payment, client, providerStatus);
    }

    switch (providerStatus?.status) {
      case 'SETTLE':
        return this.markSettledLocked(payment);

      case 'CANCEL':
      case 'REVERT':
        return this.markFailedLocked(payment, providerStatus.status, true);

      case 'VERIFY':
        payment.status = PaymentStatus.VERIFIED;
        await this.paymentRepo.save(payment);
        return this.settleStepLocked(payment, client);

      case 'PENDING':
        if (!this.hasOkCallback(payment)) {
          // هنوز هیچ مدرکی از پرداخت کاربر نداریم؛ verify کورکورانه نمی‌زنیم
          return this.pendingResult(
            payment,
            'در انتظار تکمیل پرداخت در اسنپ‌پی',
          );
        }
        return this.verifyStepLocked(payment, client);

      default:
        if (payment.status === PaymentStatus.VERIFIED) {
          return this.settleStepLocked(payment, client);
        }
        if (this.hasOkCallback(payment)) {
          return this.verifyStepLocked(payment, client);
        }
        return this.pendingResult(
          payment,
          'استعلام وضعیت اسنپ‌پی ناموفق بود؛ تراکنش در حال بررسی است',
        );
    }
  }

  private async verifyStepLocked(
    payment: Payment,
    client: SnappPayClient,
  ): Promise<SnappayOperationResult> {
    const token = this.getPaymentToken(payment);

    // حداکثر دو تلاش در یک دور: تلاش دوم فقط وقتی که بعد از timeout اول
    // استعلام status گفت هنوز PENDING است (روند صریح مستند). تلاش‌های
    // بعدی هم فقط از مسیر status در دور بعدی scheduler اتفاق می‌افتد.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await client.verify(token);

        if (result.transactionId !== payment.providerId) {
          this.logger.error(
            `❌ transactionId پاسخ verify اسنپ‌پی برای پرداخت ${payment.id} مطابقت ندارد`,
          );
          return this.pendingResult(
            payment,
            'شناسهٔ تراکنش تأییدشده معتبر نیست',
          );
        }

        payment.status = PaymentStatus.VERIFIED;
        payment.resCode = 'VERIFY';
        this.setMeta(payment, {
          status: 'VERIFY',
          verify: {
            transactionId: result.transactionId,
            at: new Date().toISOString(),
          },
        });
        await this.paymentRepo.save(payment);

        return this.settleStepLocked(payment, client);
      } catch (error) {
        this.logger.warn(
          `verify اسنپ‌پی برای پرداخت ${payment.id} (تلاش ${attempt}) نتیجهٔ قطعی نداد: ` +
            (error instanceof Error ? error.message : String(error)),
        );

        const providerStatus = await this.tryStatus(client, payment);

        if (providerStatus?.status === 'SETTLE') {
          return this.markSettledLocked(payment);
        }

        if (providerStatus?.status === 'VERIFY') {
          payment.status = PaymentStatus.VERIFIED;
          payment.resCode = 'VERIFY';
          await this.paymentRepo.save(payment);
          return this.settleStepLocked(payment, client);
        }

        if (
          providerStatus?.status === 'CANCEL' ||
          providerStatus?.status === 'REVERT'
        ) {
          return this.markFailedLocked(payment, providerStatus.status, true);
        }

        if (providerStatus?.status === 'PENDING' && attempt < 2) {
          continue;
        }

        // نامشخص: پرداخت FAILED نمی‌شود و سفارش لغو نمی‌شود
        return this.pendingResult(
          payment,
          'نتیجهٔ تأیید پرداخت اسنپ‌پی هنوز مشخص نیست؛ تراکنش در حال بررسی است',
        );
      }
    }

    return this.pendingResult(payment, 'نتیجهٔ تأیید پرداخت اسنپ‌پی مشخص نیست');
  }

  private async settleStepLocked(
    payment: Payment,
    client: SnappPayClient,
  ): Promise<SnappayOperationResult> {
    const token = this.getPaymentToken(payment);

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await client.settle(token);

        if (result.transactionId !== payment.providerId) {
          this.logger.error(
            `❌ transactionId پاسخ settle اسنپ‌پی برای پرداخت ${payment.id} مطابقت ندارد`,
          );
          return this.pendingResult(
            payment,
            'شناسهٔ تراکنش تسویه‌شده معتبر نیست',
          );
        }

        this.setMeta(payment, {
          settle: {
            transactionId: result.transactionId,
            at: new Date().toISOString(),
          },
        });
        return this.markSettledLocked(payment);
      } catch (error) {
        this.logger.warn(
          `settle اسنپ‌پی برای پرداخت ${payment.id} (تلاش ${attempt}) نتیجهٔ قطعی نداد: ` +
            (error instanceof Error ? error.message : String(error)),
        );

        const providerStatus = await this.tryStatus(client, payment);

        if (providerStatus?.status === 'SETTLE') {
          return this.markSettledLocked(payment);
        }

        if (
          providerStatus?.status === 'CANCEL' ||
          providerStatus?.status === 'REVERT'
        ) {
          return this.markFailedLocked(payment, providerStatus.status, true);
        }

        if (providerStatus?.status === 'VERIFY' && attempt < 2) {
          // طبق مستند: status برابر VERIFY یعنی settle دوباره صدا زده شود
          continue;
        }

        // VERIFIED می‌ماند؛ گارد مشترک جلوی پرداخت دوم را می‌گیرد و
        // scheduler در دور بعدی از status ادامه می‌دهد.
        return this.pendingResult(
          payment,
          'تسویهٔ پرداخت اسنپ‌پی هنوز کامل نشده است؛ تراکنش در حال بررسی است',
        );
      }
    }

    return this.pendingResult(payment, 'تسویهٔ پرداخت اسنپ‌پی مشخص نیست');
  }

  /**
   * سفارش از راه دیگری نهایی شده (پرداخت موفق دیگر، کیف پول، یا لغو
   * سفارش) ولی این توکن هم پرداخت شده است: نباید verify/settle شود.
   * اگر هنوز settle نشده revert می‌شود تا وجه برگردد؛ اگر settle شده
   * (دوبار پول گرفته شده) با پرچم duplicate ثبت و برای لغو از مسیر
   * ادمین (Cancel) علامت‌گذاری می‌شود.
   */
  private async handleDuplicateLocked(
    payment: Payment,
    client: SnappPayClient,
    providerStatus: SnappayStatusResponse | null,
  ): Promise<SnappayOperationResult> {
    if (providerStatus?.status === 'SETTLE') {
      payment.status = PaymentStatus.SUCCESS;
      payment.resCode = 'SETTLE';
      payment.saleReferenceId = payment.providerId;
      this.setMeta(payment, {
        status: 'SETTLE',
        duplicate: true,
        duplicateAt: new Date().toISOString(),
      });
      await this.paymentRepo.save(payment);

      this.logger.error(
        `❌❌ پرداخت اسنپ‌پی ${payment.id} برای سفارش ${payment.orderId} settle شده ` +
          'ولی سفارش از راه دیگری نهایی شده است؛ وجه این تراکنش باید از مسیر لغو اسنپ‌پی (ادمین) برگردانده شود.',
      );

      return this.successResult(payment, 'پرداخت دریافت شد');
    }

    if (
      providerStatus?.status === 'CANCEL' ||
      providerStatus?.status === 'REVERT'
    ) {
      return this.markFailedLocked(payment, providerStatus.status, false);
    }

    const moneyTaken =
      providerStatus?.status === 'VERIFY' ||
      (providerStatus?.status === 'PENDING' && this.hasOkCallback(payment));

    if (!moneyTaken) {
      if (providerStatus?.status === 'PENDING') {
        // توکن پرداخت‌نشده و سفارش هم جای دیگری نهایی شده؛ تلاش رها می‌شود.
        // اگر کاربر بعداً همین توکن را بپردازد callback موفق آن را احیا
        // می‌کند و همین مسیرِ برگشت وجه اجرا می‌شود.
        return this.markFailedLocked(payment, 'STALE', false);
      }

      return this.pendingResult(
        payment,
        'وضعیت پرداخت اسنپ‌پی برای تعیین تکلیف مشخص نیست',
      );
    }

    try {
      const result = await client.revert(this.getPaymentToken(payment));

      if (result.transactionId !== payment.providerId) {
        return this.pendingResult(payment, 'شناسهٔ تراکنش برگشتی معتبر نیست');
      }

      this.setMeta(payment, {
        status: 'REVERT',
        duplicate: true,
        revert: {
          transactionId: result.transactionId,
          at: new Date().toISOString(),
          reason: 'duplicate',
        },
      });

      this.logger.warn(
        `وجه پرداخت تکراری اسنپ‌پی ${payment.id} برای سفارش ${payment.orderId} با revert برگردانده شد.`,
      );

      return this.markFailedLocked(payment, 'DUPLICATE_REVERTED', false);
    } catch (error) {
      this.logger.error(
        `❌ برگشت وجه پرداخت تکراری اسنپ‌پی ${payment.id} (سفارش ${payment.orderId}) کامل نشد؛ نیاز به بررسی دستی دارد`,
        error instanceof Error ? error.stack : String(error),
      );
      return this.pendingResult(
        payment,
        'برگشت وجه پرداخت تکراری اسنپ‌پی در حال بررسی است',
      );
    }
  }

  private async isDuplicateForOrder(payment: Payment): Promise<boolean> {
    if (!payment.orderId) {
      return false;
    }

    const otherSuccess = await this.paymentRepo.findOne({
      where: {
        orderId: payment.orderId,
        status: PaymentStatus.SUCCESS,
        id: Not(payment.id),
      },
    });

    if (otherSuccess) {
      return true;
    }

    const orderStatus = await this.getOrderStatus(payment.orderId);

    return orderStatus !== null && orderStatus !== OrderStatus.PENDING;
  }

  private async markSettledLocked(
    payment: Payment,
  ): Promise<SnappayOperationResult> {
    payment.status = PaymentStatus.SUCCESS;
    payment.resCode = 'SETTLE';
    payment.saleReferenceId = payment.providerId;
    this.setMeta(payment, { status: 'SETTLE' });
    await this.paymentRepo.save(payment);

    // سفارش فقط و فقط بعد از settle موفق نهایی می‌شود
    return this.finalizeOrderLocked(payment);
  }

  private async finalizeOrderLocked(
    payment: Payment,
  ): Promise<SnappayOperationResult> {
    try {
      const order = await this.ordersService.findOneForAdmin(payment.orderId!);

      if (order.status === OrderStatus.PENDING) {
        await this.ordersService.confirmOrderPayment(payment.orderId!);
      }

      if (
        order.status === OrderStatus.PENDING ||
        order.status === OrderStatus.PAID ||
        order.status === OrderStatus.SHIPPED ||
        order.status === OrderStatus.DELIVERED
      ) {
        if (!this.getMeta(payment).orderConfirmed) {
          this.setMeta(payment, { orderConfirmed: true });
          await this.paymentRepo.save(payment);
        }
      } else {
        this.logger.error(
          `❌ پرداخت اسنپ‌پی ${payment.id} settle شده ولی سفارش ${payment.orderId} ` +
            `در وضعیت ${order.status} است؛ وجه باید از مسیر لغو اسنپ‌پی (ادمین) برگردد.`,
        );
      }
    } catch (error) {
      /*
       * پول سمت اسنپ‌پی settle شده است؛ پرداخت SUCCESS می‌ماند (گارد
       * جلوی پرداخت دوم را می‌گیرد) و scheduler نهایی‌سازی سفارش را
       * دوباره تلاش می‌کند.
       */
      this.logger.error(
        `❌ پرداخت اسنپ‌پی ${payment.id} موفق بود ولی ثبت نهایی سفارش ${payment.orderId} خطا خورد؛ ` +
          'پرداخت SUCCESS و سفارش در انتظار می‌ماند تا بررسی شود.',
        error instanceof Error ? error.stack : String(error),
      );

      return {
        success: true,
        pending: false,
        message: 'پرداخت دریافت شد؛ ثبت نهایی سفارش به‌زودی انجام می‌شود',
        orderId: payment.orderId ?? undefined,
      };
    }

    return this.successResult(payment, 'پرداخت با موفقیت انجام شد');
  }

  private async markFailedLocked(
    payment: Payment,
    resCode: string,
    failOrder: boolean,
  ): Promise<SnappayOperationResult> {
    if (payment.status === PaymentStatus.SUCCESS) {
      return this.successResult(payment, 'پرداخت قبلاً با موفقیت ثبت شده است');
    }

    payment.status = PaymentStatus.FAILED;
    payment.resCode = resCode;
    this.setMeta(payment, { failedAt: new Date().toISOString() });
    await this.paymentRepo.save(payment);

    if (failOrder && payment.orderId) {
      try {
        // فقط سفارشی که هنوز در انتظار پرداخت است لغو می‌شود؛ سفارش
        // پرداخت‌شده از راه دیگر هرگز به خاطر شکست این تلاش لغو نمی‌شود.
        const orderStatus = await this.getOrderStatus(payment.orderId);

        if (orderStatus === OrderStatus.PENDING) {
          await this.ordersService.failOrderPayment(payment.orderId);
        }
      } catch (error) {
        this.logger.error(
          `❌ لغو سفارش ${payment.orderId} پس از شکست پرداخت اسنپ‌پی ${payment.id} کامل نشد`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return {
      success: false,
      pending: false,
      message: 'پرداخت اسنپ‌پی ناموفق بود',
      orderId: payment.orderId ?? undefined,
    };
  }

  // =========================================================
  // reconciliation (scheduler)
  // =========================================================

  async reconcilePendingPayments(limit = 25): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const cutoff = new Date(Date.now() - 2 * 60_000);
    const payments = await this.paymentRepo.find({
      where: {
        gateway: PaymentGateway.SNAPPAY,
        status: In([PaymentStatus.PENDING, PaymentStatus.VERIFIED]),
        createdAt: LessThan(cutoff),
      },
      take: limit,
      order: { id: 'ASC' },
    });

    for (const payment of payments) {
      try {
        const ageMs = Date.now() - new Date(payment.createdAt).getTime();

        if (
          payment.status === PaymentStatus.PENDING &&
          !this.getPaymentToken(payment)
        ) {
          // توکن هرگز به دست ما نرسید و کاربر هم آدرس پرداخت نگرفته است
          if (ageMs > 60 * 60_000) {
            payment.status = PaymentStatus.FAILED;
            payment.resCode = 'TOKEN_UNKNOWN';
            await this.paymentRepo.save(payment);

            this.logger.warn(
              `پرداخت اسنپ‌پی ${payment.id} بدون توکن ماند و بسته شد (TOKEN_UNKNOWN).`,
            );
          }
          continue;
        }

        const result = await this.advancePayment(payment);

        if (result.success) {
          this.logger.log(
            `✅ پرداخت بلاتکلیف اسنپ‌پی ${payment.id} (سفارش ${payment.orderId}) نهایی شد.`,
          );
          continue;
        }

        /*
         * توکنِ پرداخت‌نشدهٔ رهاشده: اگر اسنپ‌پی بعد از ۲۴ ساعت هنوز
         * PENDING می‌گوید و هیچ callback موفقی هم نیامده، کاربر پرداختی
         * نکرده است (وجه verifyنشده هم طبق مستند خودکار برمی‌گردد).
         * فقط خود پرداخت بسته می‌شود؛ سفارش مثل reconciliation بقیهٔ
         * درگاه‌ها دست نمی‌خورد.
         */
        const fresh = await this.reloadPayment(payment.id);

        if (
          fresh &&
          fresh.status === PaymentStatus.PENDING &&
          !this.hasOkCallback(fresh) &&
          this.getMeta(fresh).status === 'PENDING' &&
          ageMs > SNAPPAY_ABANDONED_TOKEN_HOURS * 60 * 60_000
        ) {
          fresh.status = PaymentStatus.FAILED;
          fresh.resCode = 'EXPIRED';
          await this.paymentRepo.save(fresh);

          this.logger.warn(
            `توکن اسنپ‌پی پرداخت ${payment.id} (سفارش ${payment.orderId}) بعد از ` +
              `${SNAPPAY_ABANDONED_TOKEN_HOURS} ساعت بدون پرداخت منقضی شد.`,
          );
        }
      } catch (error) {
        this.logger.error(
          `❌ همسان‌سازی پرداخت اسنپ‌پی ${payment.id} خطا خورد`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    // پرداخت settle‌شده‌ای که نهایی‌سازی سفارشش وسط کار مانده است
    const unconfirmed = await this.paymentRepo.find({
      where: {
        gateway: PaymentGateway.SNAPPAY,
        status: PaymentStatus.SUCCESS,
        createdAt: MoreThan(new Date(Date.now() - 7 * 24 * 60 * 60_000)),
      },
      take: limit,
      order: { id: 'DESC' },
    });

    for (const payment of unconfirmed) {
      if (this.getMeta(payment).orderConfirmed) {
        continue;
      }

      try {
        await this.advancePayment(payment);
      } catch (error) {
        this.logger.error(
          `❌ نهایی‌سازی سفارش پرداخت اسنپ‌پی ${payment.id} خطا خورد`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  // =========================================================
  // عملیات ادمین: Cancel / Update / استعلام دستی
  // =========================================================

  /**
   * لغو تراکنش settle‌شده (برگشت کامل وجه به اعتبار کاربر).
   * برگشت‌ناپذیر است؛ confirm صریح ادمین الزامی است و قبل از هر تلاشی
   * وضعیت از اسنپ‌پی استعلام می‌شود تا نتیجهٔ تلاش قبلی نامشخص، دوباره
   * کاری نسازد.
   */
  async adminCancelPayment(paymentId: number, dto: SnappayAdminCancelDto) {
    if (dto.confirm !== true) {
      throw new BadRequestException(
        'لغو تراکنش اسنپ‌پی برگشت‌ناپذیر است و به تأیید صریح ادمین نیاز دارد (confirm: true)',
      );
    }

    const payment = await this.findPaymentByIdOrFail(paymentId);

    return this.withPaymentLock(payment.id, async () => {
      const fresh = (await this.reloadPayment(payment.id)) ?? payment;
      const meta = this.getMeta(fresh);

      if (meta.cancel) {
        return {
          paymentId: fresh.id,
          transactionId: fresh.providerId,
          cancelled: true,
          alreadyCancelled: true,
          orderCancelled: false,
        };
      }

      const token = this.getPaymentToken(fresh);

      if (!token) {
        throw new BadRequestException(
          'برای این پرداخت توکن اسنپ‌پی ثبت نشده است',
        );
      }

      const client = this.getClient();
      const providerStatus = await this.statusOrFail(client, fresh);

      if (providerStatus.status === 'SETTLE') {
        try {
          const result = await client.cancel(token);

          if (result.transactionId !== fresh.providerId) {
            throw new BadRequestException(
              'شناسهٔ تراکنش پاسخ لغو اسنپ‌پی مطابقت ندارد؛ وضعیت را استعلام کنید',
            );
          }
        } catch (error) {
          if (error instanceof BadRequestException) {
            throw error;
          }

          // نتیجهٔ نامشخص: اول استعلام، بعد تصمیم (تلاش کورکورانه ممنوع)
          const recheck = await this.tryStatus(client, fresh);

          if (recheck?.status === 'SETTLE') {
            throw new BadRequestException(
              'لغو تراکنش در اسنپ‌پی انجام نشد؛ می‌توانید دوباره تلاش کنید',
            );
          }

          if (recheck?.status !== 'CANCEL') {
            throw new BadRequestException(
              'نتیجهٔ لغو تراکنش اسنپ‌پی نامشخص است؛ قبل از تلاش مجدد وضعیت را استعلام کنید',
            );
          }
        }
      } else if (providerStatus.status !== 'CANCEL') {
        throw new BadRequestException(
          `لغو فقط برای تراکنش settle‌شده ممکن است؛ وضعیت فعلی در اسنپ‌پی: ${providerStatus.status}`,
        );
      }

      this.setMeta(fresh, {
        status: 'CANCEL',
        cancel: {
          transactionId: fresh.providerId,
          at: new Date().toISOString(),
        },
      });
      fresh.resCode = 'CANCEL';
      // وضعیت داخلی SUCCESS می‌ماند: وجه گرفته و سپس برگردانده شده و
      // سابقهٔ لغو در gatewayResponse.snappay.cancel قابل مشاهده است.
      await this.paymentRepo.save(fresh);

      let orderCancelled = false;
      let warning: string | undefined;

      if (dto.cancelOrder !== false && fresh.orderId) {
        try {
          const orderStatus = await this.getOrderStatus(fresh.orderId);

          if (orderStatus && orderStatus !== OrderStatus.CANCELLED) {
            await this.ordersService.adminCancelOrder(
              fresh.orderId,
              dto.reason?.trim() || 'لغو تراکنش اسنپ‌پی توسط ادمین',
            );
            orderCancelled = true;
          }
        } catch (error) {
          this.logger.error(
            `❌ تراکنش اسنپ‌پی پرداخت ${fresh.id} لغو شد ولی لغو سفارش ${fresh.orderId} در سایت کامل نشد`,
            error instanceof Error ? error.stack : String(error),
          );
          warning =
            'تراکنش در اسنپ‌پی لغو شد ولی لغو سفارش در سایت کامل نشد؛ سفارش را دستی بررسی و لغو کنید';
        }
      }

      return {
        paymentId: fresh.id,
        transactionId: fresh.providerId,
        cancelled: true,
        orderCancelled,
        ...(warning ? { warning } : {}),
      };
    });
  }

  /**
   * کم کردن مبلغ/اقلام تراکنش settle‌شده (مثلاً حذف یک قلم ناموجود).
   * مبلغ جدید حتماً باید کمتر از مبلغ فعلی باشد و اقلام دقیقاً با همان
   * قیمت واحدهای ارسالی در درخواست توکن بازسازی می‌شوند.
   *
   * توجه: این عملیات فقط مبلغ سمت اسنپ‌پی و مبلغ ثبت‌شدهٔ پرداخت را
   * به‌روز می‌کند؛ ویرایش اقلام/موجودی سفارش در سایت روال جداگانه‌ای
   * ندارد و طبق روال دستی فروشگاه انجام می‌شود.
   */
  async adminUpdatePayment(paymentId: number, dto: SnappayAdminUpdateDto) {
    if (dto.confirm !== true) {
      throw new BadRequestException(
        'ویرایش مبلغ اسنپ‌پی برگشت‌ناپذیر است و به تأیید صریح ادمین نیاز دارد (confirm: true)',
      );
    }

    const payment = await this.findPaymentByIdOrFail(paymentId);

    return this.withPaymentLock(payment.id, async () => {
      const fresh = (await this.reloadPayment(payment.id)) ?? payment;
      const meta = this.getMeta(fresh);

      if (meta.cancel) {
        throw new BadRequestException(
          'تراکنش لغوشدهٔ اسنپ‌پی قابل ویرایش نیست',
        );
      }

      if (fresh.status !== PaymentStatus.SUCCESS) {
        throw new BadRequestException(
          'ویرایش مبلغ فقط برای پرداخت موفق و settle‌شده ممکن است',
        );
      }

      const storedPurchase = meta.purchase as
        | {
            cartList?: { cartItems?: unknown[] }[];
            discountAmount?: number;
            externalSourceAmount?: number;
          }
        | undefined;
      const originalCart = storedPurchase?.cartList?.[0];

      if (!originalCart?.cartItems?.length) {
        throw new BadRequestException(
          'اطلاعات سبد اصلی این تراکنش ثبت نشده است؛ ویرایش ممکن نیست',
        );
      }

      const countByItemId = new Map<number, number>();

      for (const item of dto.items) {
        if (countByItemId.has(item.orderItemId)) {
          throw new BadRequestException(
            `قلم ${item.orderItemId} بیش از یک‌بار ارسال شده است`,
          );
        }
        countByItemId.set(item.orderItemId, item.count);
      }

      let built: ReturnType<typeof buildSnappPayUpdateCart>;

      try {
        built = buildSnappPayUpdateCart(
          originalCart as never,
          countByItemId,
          Number(storedPurchase?.discountAmount ?? 0),
          Number(storedPurchase?.externalSourceAmount ?? 0),
        );
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error
            ? error.message
            : 'سبد جدید اسنپ‌پی معتبر نیست',
        );
      }

      const currentAmount = Number(fresh.amount);

      if (built.amount >= currentAmount) {
        throw new BadRequestException(
          'مبلغ جدید اسنپ‌پی باید کمتر از مبلغ فعلی تراکنش باشد',
        );
      }

      const token = this.getPaymentToken(fresh);

      if (!token) {
        throw new BadRequestException(
          'برای این پرداخت توکن اسنپ‌پی ثبت نشده است',
        );
      }

      const client = this.getClient();
      const providerStatus = await this.statusOrFail(client, fresh);

      if (providerStatus.status !== 'SETTLE') {
        throw new BadRequestException(
          `ویرایش مبلغ فقط برای تراکنش settle‌شده ممکن است؛ وضعیت فعلی در اسنپ‌پی: ${providerStatus.status}`,
        );
      }

      // تلاش قبلیِ نامشخص شاید در واقع اعمال شده باشد
      if (providerStatus.amount === built.amount) {
        await this.applyUpdateLocally(fresh, built, dto, currentAmount);
        return {
          paymentId: fresh.id,
          transactionId: fresh.providerId,
          previousAmount: currentAmount,
          amount: built.amount,
          alreadyApplied: true,
        };
      }

      if (providerStatus.amount !== currentAmount) {
        throw new BadRequestException(
          `مبلغ تراکنش در اسنپ‌پی (${providerStatus.amount} ریال) با مبلغ ثبت‌شده در سایت ` +
            `(${currentAmount} ریال) مغایرت دارد؛ قبل از ویرایش دستی بررسی شود`,
        );
      }

      try {
        const result = await client.update({
          amount: built.amount,
          cartList: built.cartList,
          discountAmount: built.discountAmount,
          externalSourceAmount: built.externalSourceAmount,
          paymentToken: token,
        });

        if (result.transactionId !== fresh.providerId) {
          throw new BadRequestException(
            'شناسهٔ تراکنش پاسخ ویرایش اسنپ‌پی مطابقت ندارد؛ وضعیت را استعلام کنید',
          );
        }
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }

        const recheck = await this.tryStatusRaw(client, token);

        if (recheck?.amount === built.amount) {
          await this.applyUpdateLocally(fresh, built, dto, currentAmount);
          return {
            paymentId: fresh.id,
            transactionId: fresh.providerId,
            previousAmount: currentAmount,
            amount: built.amount,
            alreadyApplied: true,
          };
        }

        if (recheck?.amount === currentAmount) {
          throw new BadRequestException(
            'ویرایش مبلغ در اسنپ‌پی انجام نشد؛ می‌توانید دوباره تلاش کنید',
          );
        }

        throw new BadRequestException(
          'نتیجهٔ ویرایش مبلغ اسنپ‌پی نامشخص است؛ قبل از تلاش مجدد وضعیت و مبلغ را استعلام کنید',
        );
      }

      await this.applyUpdateLocally(fresh, built, dto, currentAmount);

      return {
        paymentId: fresh.id,
        transactionId: fresh.providerId,
        previousAmount: currentAmount,
        amount: built.amount,
        note: 'مبلغ سمت اسنپ‌پی به‌روزرسانی شد؛ اقلام و موجودی سفارش در سایت طبق روال دستی فروشگاه مدیریت شود',
      };
    });
  }

  /** استعلام و پیش‌برد دستی یک پرداخت از پنل/ابزار ادمین */
  async adminReconcilePayment(paymentId: number) {
    const payment = await this.findPaymentByIdOrFail(paymentId);
    const result = await this.advancePayment(payment);
    const fresh = (await this.reloadPayment(payment.id)) ?? payment;

    return {
      paymentId: fresh.id,
      transactionId: fresh.providerId,
      status: fresh.status,
      resCode: fresh.resCode,
      snappayStatus: this.getMeta(fresh).status ?? null,
      amount: Number(fresh.amount),
      ...result,
    };
  }

  private async applyUpdateLocally(
    payment: Payment,
    built: ReturnType<typeof buildSnappPayUpdateCart>,
    dto: SnappayAdminUpdateDto,
    previousAmount: number,
  ): Promise<void> {
    const meta = this.getMeta(payment);
    const updates = Array.isArray(meta.updates) ? meta.updates : [];

    payment.amount = built.amount;
    this.setMeta(payment, {
      purchase: {
        ...(meta.purchase as Record<string, unknown>),
        amount: built.amount,
        cartList: built.cartList,
      },
      updates: [
        ...updates,
        {
          at: new Date().toISOString(),
          previousAmount,
          amount: built.amount,
          items: dto.items,
        },
      ],
    });
    await this.paymentRepo.save(payment);
  }

  // =========================================================
  // کمکی
  // =========================================================

  private async findPaymentByIdOrFail(paymentId: number): Promise<Payment> {
    const payment = await this.paymentRepo.findOne({
      where: { id: paymentId, gateway: PaymentGateway.SNAPPAY },
    });

    if (!payment) {
      throw new NotFoundException('پرداخت اسنپ‌پی یافت نشد');
    }

    return payment;
  }

  private async reloadPayment(paymentId: number): Promise<Payment | null> {
    return this.paymentRepo.findOne({ where: { id: paymentId } });
  }

  /** استعلام وضعیت با کنترل transactionId و مبلغ؛ نتیجه در پرداخت ثبت می‌شود */
  private async tryStatus(
    client: SnappPayClient,
    payment: Payment,
  ): Promise<SnappayStatusResponse | null> {
    const result = await this.tryStatusRaw(
      client,
      this.getPaymentToken(payment),
    );

    if (!result) {
      return null;
    }

    if (result.transactionId !== payment.providerId) {
      this.logger.error(
        `❌ transactionId پاسخ status اسنپ‌پی برای پرداخت ${payment.id} مطابقت ندارد`,
      );
      return null;
    }

    if (result.amount !== Number(payment.amount)) {
      this.logger.error(
        `❌ مبلغ status اسنپ‌پی برای پرداخت ${payment.id} با مبلغ ثبت‌شده نمی‌خواند: ` +
          `expected=${payment.amount}, received=${result.amount}`,
      );
      this.setMeta(payment, {
        lastStatus: { ...result, at: new Date().toISOString() },
      });
      await this.paymentRepo.save(payment);
      return null;
    }

    payment.resCode = result.status;
    this.setMeta(payment, {
      status: result.status,
      lastStatus: { ...result, at: new Date().toISOString() },
    });
    await this.paymentRepo.save(payment);

    return result;
  }

  private async tryStatusRaw(
    client: SnappPayClient,
    paymentToken: string,
  ): Promise<SnappayStatusResponse | null> {
    if (!paymentToken) {
      return null;
    }

    try {
      return await client.status(paymentToken);
    } catch (error) {
      this.logger.warn(
        'استعلام وضعیت (status) اسنپ‌پی نتیجهٔ قطعی نداد: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }

  /** نسخهٔ ادمین: در صورت نامشخص بودن استعلام، عملیات اصلاً شروع نمی‌شود */
  private async statusOrFail(
    client: SnappPayClient,
    payment: Payment,
  ): Promise<SnappayStatusResponse> {
    let result: SnappayStatusResponse;

    try {
      result = await client.status(this.getPaymentToken(payment));
    } catch (error) {
      this.logger.error(
        `❌ استعلام وضعیت اسنپ‌پی برای پرداخت ${payment.id} در عملیات ادمین ناموفق بود`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadRequestException(
        'استعلام وضعیت تراکنش از اسنپ‌پی ناموفق بود؛ عملیات انجام نشد',
      );
    }

    if (result.transactionId !== payment.providerId) {
      throw new BadRequestException(
        'شناسهٔ تراکنش پاسخ اسنپ‌پی با پرداخت ثبت‌شده مطابقت ندارد',
      );
    }

    this.setMeta(payment, {
      lastStatus: { ...result, at: new Date().toISOString() },
    });
    await this.paymentRepo.save(payment);

    return result;
  }

  private getPaymentToken(payment: Payment): string {
    const stored = this.getMeta(payment).paymentToken;

    if (typeof stored === 'string' && stored.trim()) {
      return stored.trim();
    }

    // قبل از دریافت توکن، refId همان transactionId است و توکنی وجود ندارد
    if (payment.refId && payment.refId !== payment.providerId) {
      return payment.refId;
    }

    return '';
  }

  private hasOkCallback(payment: Payment): boolean {
    return Boolean(this.getMeta(payment).callbackOk);
  }

  private async getOrderStatus(
    orderId: number | null,
  ): Promise<OrderStatus | null> {
    if (!orderId) {
      return null;
    }

    try {
      const order = await this.ordersService.findOneForAdmin(orderId);

      return order.status;
    } catch {
      return null;
    }
  }

  private successResult(
    payment: Payment,
    message: string,
  ): SnappayOperationResult {
    return {
      success: true,
      pending: false,
      message,
      orderId: payment.orderId ?? undefined,
    };
  }

  private pendingResult(
    payment: Payment,
    message: string,
  ): SnappayOperationResult {
    return {
      success: false,
      pending: true,
      message,
      orderId: payment.orderId ?? undefined,
    };
  }

  private getMeta(payment: Payment): Record<string, any> {
    const response = payment.gatewayResponse;
    const meta =
      response &&
      typeof response === 'object' &&
      !Array.isArray(response) &&
      response.snappay &&
      typeof response.snappay === 'object' &&
      !Array.isArray(response.snappay)
        ? (response.snappay as Record<string, any>)
        : {};

    return meta;
  }

  private setMeta(payment: Payment, patch: Record<string, unknown>): void {
    const current = payment.gatewayResponse;
    const base =
      current && typeof current === 'object' && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {};

    payment.gatewayResponse = {
      ...base,
      snappay: { ...this.getMeta(payment), ...patch },
    };
  }

  private async withPaymentLock<T>(
    paymentId: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.paymentLocks.get(paymentId) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const chained = previous.then(() => current);

    this.paymentLocks.set(paymentId, chained);
    await previous;

    try {
      return await fn();
    } finally {
      release();

      if (this.paymentLocks.get(paymentId) === chained) {
        this.paymentLocks.delete(paymentId);
      }
    }
  }
}
