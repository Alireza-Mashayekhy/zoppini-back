/**
 * SnappPay REST API v2.1 transport only. This client is intentionally not
 * registered with PaymentModule: accepting payments also requires a durable,
 * idempotent order/settlement workflow (see SNAPPAY_INTEGRATION.md).
 */
export type SnappPayMethod = 'POSTPAID' | 'INSTALLMENT' | 'FINANCING';
export type SnappPayStatus =
  'PENDING' | 'VERIFY' | 'SETTLE' | 'CANCEL' | 'REVERT';

export interface SnappPayItem {
  id: number;
  name: string;
  category: string;
  amount: number; // per unit, IRR
  count: number;
  commissionType: number;
}

export interface SnappPayCart {
  cartId: number;
  cartItems: SnappPayItem[];
  isShipmentIncluded: boolean;
  isTaxIncluded: boolean;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
}

export interface SnappPayPurchase {
  amount: number;
  cartList: SnappPayCart[];
  discountAmount: number;
  externalSourceAmount: number;
  mobile: string;
  returnURL: string;
  transactionId: string;
  forcedPaymentMethodTypes?: SnappPayMethod[];
}

export interface SnappPayUpdate {
  amount: number;
  cartList: SnappPayCart[];
  discountAmount: number;
  externalSourceAmount: number;
  paymentToken: string;
}

export interface SnappPayConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

/** An inconclusive network/timeout error must not be treated as a failed payment. */
export class SnappPayError extends Error {
  constructor(
    message: string,
    readonly kind: 'configuration' | 'transport' | 'provider' | 'protocol',
    readonly httpStatus?: number,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'SnappPayError';
  }
}

export class SnappPayClient {
  private accessToken?: string;
  private expiresAt = 0;
  private tokenRequest?: Promise<string>;
  private readonly baseUrl: string;

  constructor(private readonly config: SnappPayConfig) {
    if (
      !config.baseUrl ||
      !config.clientId ||
      !config.clientSecret ||
      !config.username ||
      !config.password
    ) {
      throw new SnappPayError('تنظیمات اسنپ‌پی کامل نیست', 'configuration');
    }
    let url: URL;
    try {
      url = new URL(config.baseUrl);
    } catch {
      throw new SnappPayError('آدرس اسنپ‌پی نامعتبر است', 'configuration');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new SnappPayError(
        'آدرس اسنپ‌پی باید HTTPS و بدون اطلاعات اضافی باشد',
        'configuration',
      );
    }
    this.baseUrl = url.toString().replace(/\/+$/, '');
  }

  private async fetchJson(
    path: string,
    init: RequestInit,
  ): Promise<{ status: number; ok: boolean; data: any }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
    } catch {
      throw new SnappPayError('ارتباط با اسنپ‌پی نامشخص است', 'transport');
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new SnappPayError(
        'پاسخ اسنپ‌پی معتبر نیست',
        'protocol',
        response.status,
      );
    }
    return { status: response.status, ok: response.ok, data };
  }

  private async access(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt)
      return this.accessToken;
    if (!this.tokenRequest) {
      this.tokenRequest = this.requestAccess().finally(() => {
        this.tokenRequest = undefined;
      });
    }
    return this.tokenRequest;
  }

  private async requestAccess(): Promise<string> {
    const basic = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
      'utf8',
    ).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'password',
      scope: 'online-merchant',
      username: this.config.username,
      password: this.config.password,
    });
    const { ok, status, data } = await this.fetchJson(
      '/api/online/v1/oauth/token',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      },
    );
    if (!ok)
      throw new SnappPayError(
        'احراز هویت اسنپ‌پی ناموفق بود',
        'provider',
        status,
      );
    if (
      typeof data?.access_token !== 'string' ||
      !data.access_token ||
      !Number.isFinite(Number(data.expires_in)) ||
      Number(data.expires_in) <= 0
    ) {
      throw new SnappPayError(
        'پاسخ احراز هویت اسنپ‌پی معتبر نیست',
        'protocol',
        status,
      );
    }
    // Leave a safety margin and never extend a token beyond its lifetime.
    const lifetime = Number(data.expires_in) * 1000;
    this.accessToken = data.access_token;
    this.expiresAt =
      Date.now() + Math.max(0, lifetime - Math.min(60_000, lifetime / 2));
    return data.access_token;
  }

  private async call(
    path: string,
    method: 'GET' | 'POST',
    body?: object,
  ): Promise<any> {
    const token = await this.access();
    const { ok, status, data } = await this.fetchJson(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (status === 401 && this.accessToken === token) {
      this.accessToken = undefined;
      this.expiresAt = 0;
    }
    if (!ok || data?.successful === false) {
      throw new SnappPayError(
        'درخواست اسنپ‌پی ناموفق بود',
        'provider',
        status,
        data?.errorData?.errorCode == null
          ? undefined
          : String(data.errorData.errorCode),
      );
    }
    if (
      data?.successful !== true ||
      !data.response ||
      typeof data.response !== 'object' ||
      Array.isArray(data.response)
    ) {
      throw new SnappPayError('پاسخ اسنپ‌پی معتبر نیست', 'protocol', status);
    }
    return data.response;
  }

  async eligible(
    amount: number,
    methods?: SnappPayMethod[],
  ): Promise<{
    eligible: boolean;
    title_message?: string;
    description?: string;
  }> {
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new SnappPayError('مبلغ نامعتبر است', 'configuration');
    const query = new URLSearchParams({ amount: String(amount) });
    if (methods?.length) query.set('paymentMethodTypes', methods.join(','));
    const response = await this.call(
      `/api/online/offer/v1/eligible?${query}`,
      'GET',
    );
    if (
      typeof response.eligible !== 'boolean' ||
      (response.eligible &&
        (typeof response.title_message !== 'string' ||
          typeof response.description !== 'string'))
    ) {
      throw new SnappPayError(
        'پاسخ eligibility اسنپ‌پی معتبر نیست',
        'protocol',
      );
    }
    return response;
  }

  async createPayment(
    purchase: SnappPayPurchase,
  ): Promise<{ paymentToken: string; paymentPageUrl: string }> {
    const response = await this.call(
      '/api/online/payment/v1/token',
      'POST',
      purchase,
    );
    if (
      typeof response.paymentToken !== 'string' ||
      !response.paymentToken ||
      typeof response.paymentPageUrl !== 'string'
    ) {
      throw new SnappPayError('توکن پرداخت اسنپ‌پی معتبر نیست', 'protocol');
    }
    try {
      const url = new URL(response.paymentPageUrl);
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error();
    } catch {
      throw new SnappPayError('آدرس پرداخت اسنپ‌پی معتبر نیست', 'protocol');
    }
    return response;
  }

  async status(paymentToken: string): Promise<{
    transactionId: string;
    status: SnappPayStatus;
    amount: number;
  }> {
    const query = new URLSearchParams({ paymentToken });
    const response = await this.call(
      `/api/online/payment/v1/status?${query}`,
      'GET',
    );
    if (
      typeof response.transactionId !== 'string' ||
      !['PENDING', 'VERIFY', 'SETTLE', 'CANCEL', 'REVERT'].includes(
        response.status,
      ) ||
      !Number.isSafeInteger(response.amount) ||
      response.amount < 0
    ) {
      throw new SnappPayError('وضعیت پرداخت اسنپ‌پی معتبر نیست', 'protocol');
    }
    return response;
  }

  private async operation(
    name: 'verify' | 'settle' | 'cancel' | 'update',
    body: object,
  ): Promise<{ transactionId: string }> {
    const response = await this.call(
      `/api/online/payment/v1/${name}`,
      'POST',
      body,
    );
    if (typeof response.transactionId !== 'string' || !response.transactionId) {
      throw new SnappPayError('شناسه تراکنش اسنپ‌پی معتبر نیست', 'protocol');
    }
    return response;
  }

  verify(paymentToken: string) {
    return this.operation('verify', { paymentToken });
  }
  settle(paymentToken: string) {
    return this.operation('settle', { paymentToken });
  }
  cancel(paymentToken: string) {
    return this.operation('cancel', { paymentToken });
  }
  update(update: SnappPayUpdate) {
    return this.operation('update', update);
  }
}
