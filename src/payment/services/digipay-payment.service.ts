// src/payment/services/digipay-payment.service.ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { OrdersService } from 'src/order/order.service';
import { WalletChargeStatus } from 'src/wallet/entities/wallet-charge.entity';
import { LessThan, Repository } from 'typeorm';

import {
  Payment,
  PaymentGateway,
  PaymentPurpose,
  PaymentStatus,
} from '../entities/payment.entity';
import { DigipayAuthService } from './digipay-auth.service';
import { PaymentGuardService } from './payment-guard.service';
import { WalletChargeService } from './wallet-charge.service';

const DIGIPAY_UPG_TICKET_TYPE = 11;

const DIGIPAY_VERIFY_TICKET_TYPES = new Set([0, 5, 11, 13, 24]);

const DIGIPAY_INCONCLUSIVE_RESULT_CODES = new Set(['9004', '9006', '9011']);

type DigipayCallbackData = {
  amount?: string;
  providerId?: string;
  trackingCode?: string;
  rrn?: string;
  psp?: unknown;
  isCredit?: string;
  type?: string;
  result?: string;
};

type DigipayOperationResult = {
  success: boolean;
  pending?: boolean;
  message: string;
  orderId?: number;
};

@Injectable()
export class DigipayPaymentService {
  private readonly logger = new Logger(DigipayPaymentService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    private readonly ordersService: OrdersService,
    private readonly authService: DigipayAuthService,

    private readonly paymentGuard: PaymentGuardService,
    private readonly walletChargeService: WalletChargeService,
  ) {}

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

  private getUserPhone(phone: unknown): string {
    const value = typeof phone === 'string' ? phone.trim() : '';

    if (!value) {
      throw new BadRequestException(
        'شماره همراه کاربر برای پرداخت دیجی‌پی ثبت نشده است',
      );
    }

    return value;
  }

  private async readJsonResponse(
    response: Response,
    operation: string,
  ): Promise<any> {
    const responseText = await response.text();

    if (!responseText.trim()) {
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

  private async requestTicket(params: {
    amount: number;
    cellNumber: string;
    providerId: string;
    callbackUrl: string;
  }): Promise<{ ticket: string; payUrl: string; response: any }> {
    const accessToken = await this.authService.getAccessToken();
    const url = `${this.getApiUrl()}/tickets/business?type=${DIGIPAY_UPG_TICKET_TYPE}`;
    const payload = {
      cellNumber: params.cellNumber,
      amount: params.amount,
      providerId: params.providerId,
      callbackUrl: params.callbackUrl,
      // سایت فقط پرداخت اینترنتی را پشتیبانی می‌کند؛ با این فیلد صفحهٔ
      // انتخاب BPG/CPG/Wallet نمایش داده نمی‌شود و type callback برابر IPG (0) است.
      additionalInfo: {
        preferredGateway: 2,
      },
    };

    this.logger.log(
      `ایجاد تیکت دیجی‌پی: amount=${params.amount}, providerId=${params.providerId}`,
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Agent: 'WEB',
        'Digipay-Version': '2022-02-02',
        'Content-Type': 'application/json; charset=UTF-8',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await this.readJsonResponse(response, 'tickets/business');
    const resultStatus = this.getResultStatus(data);

    if (!response.ok || resultStatus !== 0) {
      throw new BadRequestException(
        this.getResultMessage(data, `خطای دیجی‌پی (${response.status})`),
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

    try {
      const ticket = await this.requestTicket({
        amount,
        cellNumber,
        providerId,
        callbackUrl,
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
            preferredGateway: 2,
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
            preferredGateway: 2,
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

  async recordCallback(
    payment: Payment,
    callback: DigipayCallbackData,
  ): Promise<void> {
    this.applyCallbackData(payment, callback);
    await this.paymentRepo.save(payment);
  }

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
    const type = this.normalizeTicketType(
      callback?.type ?? storedCallback.type,
    );

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
      const accessToken = await this.authService.getAccessToken();
      const url = `${this.getApiUrl()}/purchases/verify?type=${type}`;
      const payload = { trackingCode, providerId };

      this.logger.log(
        `تأیید پرداخت دیجی‌پی: payment=${payment.id}, type=${type}, providerId=${providerId}`,
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(payload),
      });

      if (response.status === 401 || response.status === 403) {
        this.authService.clearToken();
      }

      const data = await this.readJsonResponse(response, 'purchases/verify');
      const resultStatus = this.getResultStatus(data);

      if (resultStatus !== 0) {
        const resultCode =
          resultStatus === null
            ? String(response.status)
            : String(resultStatus);

        this.mergeGatewayResponse(payment, 'verify', data);
        payment.resCode = resultCode;

        // خطای HTTP بدون بدنهٔ بیزینسی و وضعیت‌های نامشخص نباید پرداخت را
        // قطعی ناموفق کنند؛ ممکن است وجه کسر شده باشد.
        if (
          resultStatus === null ||
          (response.status !== 422 && !response.ok) ||
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

      if (!response.ok) {
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
   * تلاش مجدد برای پرداخت‌هایی که callback موفق گرفته‌اند اما verify آنها
   * به علت timeout/خطای موقت کامل نشده است.
   */
  async reconcilePendingPayments(limit = 25): Promise<void> {
    const cutoff = new Date(Date.now() - 2 * 60_000);
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

      // بدون callback موفق، trackingCode نداریم و طبق مستند امکان verify وجود
      // ندارد؛ درخواست‌های قدیمی با callback FAILURE هم قبلاً نهایی شده‌اند.
      if (
        result !== 'SUCCESS' ||
        !callback.trackingCode ||
        this.normalizeTicketType(callback.type) === null
      ) {
        continue;
      }

      await this.verifyPayment(payment, callback);
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

  private normalizeTicketType(value: unknown): number | null {
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

    this.mergeGatewayResponse(payment, 'callback', callback);
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
