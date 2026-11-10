import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from 'src/order/entities/order.entity';
import { FindOperator } from 'typeorm';

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
import { DigipayPaymentService } from './digipay-payment.service';

const ORDER_AMOUNT_RIAL = 9_700_000;
const TICKET = 'v2:ab17ec383d654be3b009f9fc45202f80';
const TRACKING_CODE = '14212206401785573880949';

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    orderNumber: 'ORD-10',
    status: OrderStatus.PENDING,
    user: { id: 1, phone: '+98 912 345 6789', fullName: 'کاربر تست' },
    items: [
      {
        id: 101,
        quantity: 2,
        price: 400_000,
        variant: {
          sku: 'SKU-1',
          product: { productCode: 'P-100', title: 'مانتو' },
          color: { name: 'مشکی' },
          size: { name: 'M' },
        },
      },
      {
        id: 102,
        quantity: 1,
        price: 300_000,
        variant: {
          sku: 'SKU-2',
          product: { productCode: 'P-100', title: 'مانتو' },
          color: { name: 'سفید' },
          size: { name: 'L' },
        },
      },
    ],
    totalPrice: 1_100_000,
    shippingCost: 0,
    discount: 0,
    finalPrice: 970_000,
    walletPayment: 0,
    ...overrides,
  } as never;
}

function matchesWhere(
  entity: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, value]) => {
    const actual = entity[key];

    if (value instanceof FindOperator) {
      switch (value.type) {
        case 'in':
          return (value.value as unknown[]).includes(actual);
        case 'isNull':
          return actual === null || actual === undefined;
        case 'not':
          return actual !== value.value;
        case 'lessThan':
          return (
            actual instanceof Date &&
            value.value instanceof Date &&
            actual.getTime() < value.value.getTime()
          );
        default:
          return false;
      }
    }

    return actual === value;
  });
}

type QueryCall = { method: string; args: unknown[] };

/** مخزن درون‌حافظه‌ای ساده با APIهای استفاده‌شده در سرویس */
function makeRepo<T extends { id?: number }>(
  queryRows: { rows: unknown[] } = { rows: [] },
  queryCalls: QueryCall[] = [],
) {
  const store = new Map<number, T>();
  let nextId = 1;

  return {
    store,
    /**
     * خلاصهٔ QueryBuilder: فقط زنجیرهٔ متدها و getMany لازم است؛ خروجی از
     * `queryRows.rows` خوانده می‌شود تا هر تست بتواند کوئری را شبیه‌سازی کند.
     */
    createQueryBuilder: jest.fn(() => {
      const builder: Record<string, unknown> = {};

      for (const method of [
        'innerJoin',
        'where',
        'andWhere',
        'orderBy',
        'take',
      ]) {
        builder[method] = jest.fn((...args: unknown[]) => {
          queryCalls.push({ method, args });

          return builder;
        });
      }

      builder.getMany = jest.fn(() => Promise.resolve(queryRows.rows));

      return builder;
    }),
    create: jest.fn((data: Partial<T>) => ({ ...data }) as T),
    save: jest.fn((entity: T) => {
      if (!entity.id) {
        entity.id = nextId++;
      }

      store.set(entity.id, entity);
      return Promise.resolve(entity);
    }),
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      for (const entity of store.values()) {
        if (matchesWhere(entity, where)) {
          return Promise.resolve(entity);
        }
      }

      return Promise.resolve(null);
    }),
    find: jest.fn(
      ({
        where = {},
        take,
      }: { where?: Record<string, unknown>; take?: number } = {}) => {
        let rows = [...store.values()].filter(entity =>
          matchesWhere(entity as never, where),
        );

        if (take) {
          rows = rows.slice(0, take);
        }

        return Promise.resolve(rows);
      },
    ),
  };
}

type FetchCall = { url: string; init: any };

type MockResponse = { status?: number; body?: unknown; text?: string };

function installFetch(
  handler: (url: string, init: any, callIndex: number) => MockResponse,
) {
  const calls: FetchCall[] = [];

  (global as unknown as { fetch: unknown }).fetch = jest.fn(
    (url: unknown, init: unknown) => {
      const callIndex = calls.length;
      calls.push({ url: String(url), init });

      const result = handler(String(url), init, callIndex);
      const status = result.status ?? 200;
      const text =
        result.text ??
        (result.body === undefined ? '' : JSON.stringify(result.body));

      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(text),
      });
    },
  );

  return calls;
}

function makeHarness(options: { config?: Record<string, string> } = {}) {
  const order = makeOrder();

  const configValues: Record<string, string> = {
    DIGIPAY_API_URL: 'https://api.digipay.example/digipay/api',
    DIGIPAY_CLIENT_ID: 'client',
    DIGIPAY_CLIENT_SECRET: 'secret',
    DIGIPAY_USERNAME: 'user',
    DIGIPAY_PASSWORD: 'pass',
    APP_URL: 'https://shop.example',
    ...options.config,
  };

  const configService = {
    get: jest.fn((name: string) => configValues[name]),
  };

  const queryRows: { rows: unknown[] } = { rows: [] };
  const queryCalls: QueryCall[] = [];
  const paymentRepo = makeRepo<Payment>(queryRows, queryCalls);
  const refundRepo = makeRepo<PaymentRefund>();

  const ordersService = {
    findOneForPayment: jest.fn(() => Promise.resolve(order)),
    findOneForAdmin: jest.fn(() => Promise.resolve(order)),
    confirmOrderPayment: jest.fn(() => {
      (order as { status: OrderStatus }).status = OrderStatus.PAID;
      return Promise.resolve(order);
    }),
    failOrderPayment: jest.fn(() => {
      (order as { status: OrderStatus }).status = OrderStatus.CANCELLED;
      return Promise.resolve(order);
    }),
  };

  const authService = {
    getAccessToken: jest.fn(() => Promise.resolve('token-1')),
    clearToken: jest.fn(),
  };

  const paymentGuard = {
    ensureOrderPayable: jest.fn(() => Promise.resolve(undefined)),
  };

  const walletChargeService = {
    getChargeWithUser: jest.fn(),
    settleCharge: jest.fn(() => Promise.resolve(undefined)),
    markChargeFailed: jest.fn(() => Promise.resolve(undefined)),
  };

  const service = new DigipayPaymentService(
    configService as never,
    paymentRepo as never,
    refundRepo as never,
    ordersService as never,
    authService as never,
    paymentGuard as never,
    walletChargeService as never,
  );

  return {
    service,
    order,
    configValues,
    paymentRepo,
    refundRepo,
    ordersService,
    authService,
    paymentGuard,
    walletChargeService,
    /** نتیجهٔ کوئری‌های QueryBuilder را برای تست‌های reconcile تعیین می‌کند */
    setQueryRows: (rows: unknown[]) => {
      queryRows.rows = rows;
    },
    /** شرط‌های SQL اعمال‌شده (برای اطمینان از درست بودن فیلترها) */
    queryCalls,
    resetQueryCalls: () => {
      queryCalls.length = 0;
    },
  };
}

function makePendingPayment(
  harness: ReturnType<typeof makeHarness>,
  overrides: Partial<Payment> = {},
): Payment {
  const payment = {
    id: 1,
    orderId: 10,
    purpose: PaymentPurpose.ORDER,
    walletChargeId: null,
    refId: TICKET,
    providerId: 'ORDER-10-1',
    amount: ORDER_AMOUNT_RIAL,
    saleReferenceId: null,
    saleOrderId: null,
    channelRefNumber: null,
    status: PaymentStatus.PENDING,
    gateway: PaymentGateway.DIGIPAY,
    gatewayResponse: {},
    resCode: '0',
    digipayPurchaseType: null,
    digipayPaymentGateway: null,
    creditProvider: null,
    repaymentOption: null,
    digipayDeliveredAt: null,
    createdAt: new Date(Date.now() - 5 * 60_000),
    updatedAt: new Date(),
    ...overrides,
  };

  harness.paymentRepo.store.set(payment.id, payment);

  return payment;
}

const successTicketResponse = {
  result: { title: 'SUCCESS', status: 0, message: 'عملیات با موفقیت انجام شد' },
  ticket: TICKET,
  redirectUrl: `https://www.mydigipay.example/web-pay/tgs/${TICKET}`,
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('DigipayPaymentService — ایجاد تیکت (UPG)', () => {
  it('در حالت upg، basketDetailsDto می‌فرستد و preferredGateway نمی‌فرستد', async () => {
    const harness = makeHarness();
    const calls = installFetch(() => ({ body: successTicketResponse }));

    const result = await harness.service.requestPayment(10, 1);

    expect(result.refId).toBe(TICKET);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/tickets/business?type=11');

    const body = JSON.parse(calls[0].init.body);

    expect(body).toMatchObject({
      amount: ORDER_AMOUNT_RIAL,
      providerId: expect.stringMatching(/^ORDER-10-\d+$/),
      callbackUrl: 'https://shop.example/api/payment/callback/digipay',
      // شمارهٔ بین‌المللی باید به قالب 09xxxxxxxxx نرمال شود
      cellNumber: '09123456789',
    });

    // صفحهٔ انتخاب BPG/CPG/Wallet نباید با preferredGateway غیرفعال شود
    expect(body.additionalInfo).toBeUndefined();

    // دو سایز از یک محصول در یک آیتم با count=3 جمع می‌شوند
    expect(body.basketDetailsDto.basketId).toMatch(/^basket-10-[a-z0-9]+$/);
    expect(body.basketDetailsDto).toEqual({
      basketId: expect.any(String),
      items: [
        {
          productCode: 'P-100',
          brand: 'ZOPPINI',
          productType: 1,
          count: 3,
        },
      ],
    });

    const stored = [...harness.paymentRepo.store.values()][0];

    expect(stored.status).toBe(PaymentStatus.PENDING);
    expect(stored.gateway).toBe(PaymentGateway.DIGIPAY);
    expect(stored.amount).toBe(ORDER_AMOUNT_RIAL);
    expect(stored.gatewayResponse.request.upgMode).toBe('upg');
  });

  it('در حالت ipg، preferredGateway=2 می‌فرستد (درگاه اینترنتی اجباری)', async () => {
    const harness = makeHarness({
      config: { DIGIPAY_UPG_MODE: 'ipg' },
    });
    const calls = installFetch(() => ({ body: successTicketResponse }));

    await harness.service.requestPayment(10, 1);

    const body = JSON.parse(calls[0].init.body);

    expect(body.additionalInfo).toEqual({ preferredGateway: 2 });
  });

  it('شمارهٔ نامعتبر را با پیام فارسی رد می‌کند', async () => {
    const harness = makeHarness();
    installFetch(() => ({ body: successTicketResponse }));

    harness.ordersService.findOneForPayment.mockResolvedValueOnce(
      makeOrder({ user: { id: 1, phone: '12345' } }),
    );

    await expect(harness.service.requestPayment(10, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(harness.paymentRepo.save).not.toHaveBeenCalled();
  });

  it('شارژ کیف پول همیشه IPG است و basketDetailsDto ندارد', async () => {
    const harness = makeHarness();
    const calls = installFetch(() => ({ body: successTicketResponse }));

    harness.walletChargeService.getChargeWithUser.mockResolvedValueOnce({
      id: 5,
      amount: 200_000,
      status: 'pending',
      user: { id: 1, phone: '09123456789' },
    });

    await harness.service.requestWalletCharge(5, 1);

    const body = JSON.parse(calls[0].init.body);

    expect(body.additionalInfo).toEqual({ preferredGateway: 2 });
    expect(body.basketDetailsDto).toBeUndefined();
    expect(body.amount).toBe(2_000_000);
  });
});

describe('DigipayPaymentService — callback و verify', () => {
  const callback = {
    amount: String(ORDER_AMOUNT_RIAL),
    providerId: 'ORDER-10-1',
    trackingCode: TRACKING_CODE,
    type: '13',
    isCredit: 'true',
    creditProvider: 'DIGIPAY',
    repaymentOption: '1',
    result: 'SUCCESS',
  };

  it('اطلاعات خرید اعتباری را ذخیره و پرداخت را تأیید می‌کند', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness);

    installFetch(url => {
      expect(url).toContain('/purchases/verify?type=13');

      return {
        body: {
          result: { status: 0, message: 'عملیات با موفقیت انجام شد' },
          trackingCode: TRACKING_CODE,
          providerId: 'ORDER-10-1',
          amount: ORDER_AMOUNT_RIAL,
          paymentGateway: 10,
          fpName: 'DIGIPAY',
          additionalInfo: { cashAmount: 2_000_000, creditAmount: 7_700_000 },
        },
      };
    });

    const result = await harness.service.verifyPayment(payment, callback);

    expect(result.success).toBe(true);
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
    expect(payment.saleReferenceId).toBe(TRACKING_CODE);
    expect(payment.digipayPurchaseType).toBe(13);
    expect(payment.digipayPaymentGateway).toBe(10);
    expect(payment.creditProvider).toBe('DIGIPAY');
    expect(payment.repaymentOption).toBe(1);
    expect(harness.ordersService.confirmOrderPayment).toHaveBeenCalledWith(10);
    expect(describeDigipayPurchase(payment)).toEqual({
      label: 'خرید اعتباری دیجی‌پی (BNPL)',
      installments: 4,
      creditProvider: 'DIGIPAY',
    });
  });

  it('مبلغ ناهمخوان را تأیید نمی‌کند و PENDING نگه می‌دارد', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness);
    const calls = installFetch(() => ({ body: {} }));

    const result = await harness.service.verifyPayment(payment, {
      ...callback,
      amount: '1000',
    });

    expect(result.pending).toBe(true);
    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(calls).toHaveLength(0);
  });

  it('کد 9011 (نتیجه نامشخص) پرداخت را FAILED نمی‌کند', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness);

    installFetch(() => ({
      status: 422,
      body: {
        result: { status: 9011, message: 'نتیجه تایید خرید نامشخص است' },
      },
    }));

    const result = await harness.service.verifyPayment(payment, callback);

    expect(result.pending).toBe(true);
    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.resCode).toBe('9011');
  });

  it('خطای قطعی 9007 را FAILED و سفارش را لغو می‌کند', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness);

    installFetch(() => ({
      status: 422,
      body: { result: { status: 9007, message: 'خرید انجام نشده است' } },
    }));

    const result = await harness.service.verifyPayment(payment, callback);

    expect(result.success).toBe(false);
    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(harness.ordersService.failOrderPayment).toHaveBeenCalledWith(10);
  });

  it('با 401 توکن را پاک می‌کند و همان درخواست را یک‌بار تکرار می‌کند', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness);

    harness.authService.getAccessToken
      .mockResolvedValueOnce('token-old')
      .mockResolvedValueOnce('token-new');

    const calls = installFetch((_url, init) => {
      const authorization = init.headers.Authorization;

      if (authorization === 'Bearer token-old') {
        return { status: 401, body: { error: 'invalid_token' } };
      }

      return {
        body: {
          result: { status: 0, message: 'ok' },
          trackingCode: TRACKING_CODE,
          providerId: 'ORDER-10-1',
          amount: ORDER_AMOUNT_RIAL,
          paymentGateway: 10,
        },
      };
    });

    const result = await harness.service.verifyPayment(payment, callback);

    expect(result.success).toBe(true);
    expect(harness.authService.clearToken).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].init.headers.Authorization).toBe('Bearer token-new');
  });

  it('خرید کیف پول دیجی‌پی که فیلد result ندارد هم verify و تأیید می‌شود', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness);

    installFetch(url => {
      // نوع خرید ۱۱ = Wallet؛ مستند نمونهٔ Wallet را بدون result نشان می‌دهد
      expect(url).toContain('/purchases/verify?type=11');

      return {
        body: {
          result: { status: 0, message: 'عملیات با موفقیت انجام شد' },
          trackingCode: TRACKING_CODE,
          providerId: 'ORDER-10-1',
          amount: ORDER_AMOUNT_RIAL,
          paymentGateway: 3,
          hashedPan: null,
        },
      };
    });

    const result = await harness.service.verifyPayment(payment, {
      amount: String(ORDER_AMOUNT_RIAL),
      providerId: 'ORDER-10-1',
      trackingCode: TRACKING_CODE,
      type: '11',
      rrn: '4970393141786201739420',
    });

    expect(result.success).toBe(true);
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
    expect(payment.digipayPurchaseType).toBe(11);
    expect(payment.digipayPaymentGateway).toBe(3);
    expect(describeDigipayPurchase(payment)?.label).toBe('کیف پول دیجی‌پی');
  });

  it('نوع خرید را از ابزار تأییدشده اصلاح می‌کند تا عودت با نوع درست انجام شود', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness);

    installFetch(() => ({
      body: {
        result: { status: 0, message: 'ok' },
        trackingCode: TRACKING_CODE,
        providerId: 'ORDER-10-1',
        amount: ORDER_AMOUNT_RIAL,
        // callback گفته بود IPG (0) ولی واقعیت CPG/اعتباری است
        paymentGateway: 4,
        fpName: 'PARSIAN_BANK',
      },
    }));

    await harness.service.verifyPayment(payment, {
      ...callback,
      type: '0',
      isCredit: 'true',
      creditProvider: 'PARSIAN_BANK',
      repaymentOption: '1',
    });

    expect(payment.digipayPurchaseType).toBe(5);
    expect(payment.digipayPaymentGateway).toBe(4);
    expect(payment.creditProvider).toBe('PARSIAN_BANK');

    const calls = installFetch(() => ({
      body: { result: { status: 0 }, trackingCode: '571000000098' },
    }));

    await harness.service.refundPayment({ payment });

    // نوع عودت باید Credit (5) باشد، نه Debit (0)
    expect(calls[0].url).toContain('/refunds?type=5');
  });

  it('callback بدون providerId با کد پیگیری تطبیق داده می‌شود', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      saleReferenceId: TRACKING_CODE,
    });

    const found =
      await harness.service.findPaymentBySaleReferenceId(TRACKING_CODE);

    expect(found?.id).toBe(payment.id);
  });
});

describe('DigipayPaymentService — اعلام تحویل (Delivery)', () => {
  it('برای خرید BNPL، تحویل را با محصولات و شماره فاکتور می‌فرستد', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 13,
      digipayPaymentGateway: 10,
    });

    const calls = installFetch(() => ({
      body: { result: { status: 0, message: 'عملیات با موفقیت انجام شد' } },
    }));

    const result = await harness.service.deliverPurchase(payment);

    expect(result.success).toBe(true);
    expect(calls[0].url).toContain('/purchases/deliver?type=13');

    const body = JSON.parse(calls[0].init.body);

    expect(body.invoiceNumber).toBe('ORD-10');
    expect(body.trackingCode).toBe(TRACKING_CODE);
    expect(body.products).toEqual(['مانتو - مشکی - M', 'مانتو - سفید - L']);
    expect(typeof body.deliveryDate).toBe('number');
    expect(payment.digipayDeliveredAt).toBeInstanceOf(Date);
  });

  it('برای خرید اینترنتی (IPG) چیزی نمی‌فرستد', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 0,
    });
    const calls = installFetch(() => ({ body: {} }));

    const result = await harness.service.deliverPurchase(payment);

    expect(result.sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('تحویل تکراری ارسال نمی‌شود', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 5,
      digipayDeliveredAt: new Date(),
    });
    const calls = installFetch(() => ({ body: {} }));

    const result = await harness.service.deliverPurchase(payment);

    expect(result.sent).toBe(false);
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('کوئری اعلام تحویل فقط خریدهای اعتباری سفارش تحویل‌شده را می‌گیرد', async () => {
    const harness = makeHarness();

    await harness.service.reconcileDeliveries();

    const sql = JSON.stringify(harness.queryCalls);

    expect(sql).toContain('payment.digipay_delivered_at IS NULL');
    expect(sql).toContain('payment.digipay_purchase_type IN');
    expect(sql).toContain('o.status = :orderStatus');
    expect(sql).toContain('payment.saleReferenceId IS NOT NULL');
  });

  it('کوئری عودت خودکار، سفارش لغوشده با ماندهٔ قابل عودت را هدف می‌گیرد', async () => {
    const harness = makeHarness();
    harness.setQueryRows([]);

    await harness.service.reconcileRefunds();

    const sql = JSON.stringify(harness.queryCalls);

    expect(sql).toContain('o.status = :orderStatus');
    expect(sql).toContain('payment_refunds r');
    expect(sql).toContain('payment.saleReferenceId IS NOT NULL');
  });

  it('در reconcile پرداخت‌های آمادهٔ اعلام تحویل را می‌فرستد', async () => {
    const harness = makeHarness();

    const payment = makePendingPayment(harness, {
      id: 1,
      orderId: 10,
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 13,
    });

    // کوئری دیتابیس (join با سفارش تحویل‌شده و فیلترهای اعتباری) شبیه‌سازی می‌شود
    harness.setQueryRows([payment]);

    const delivered = jest
      .spyOn(harness.service, 'deliverPurchase')
      .mockResolvedValue({ sent: true, success: true, message: 'ok' });

    await harness.service.reconcileDeliveries();

    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0][0].orderId).toBe(10);
  });
});

describe('DigipayPaymentService — عودت (Refund / Refund Inquiry)', () => {
  it('درخواست عودت را ثبت می‌کند و نوع عودت را از نوع خرید می‌سازد', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 13,
    });

    const calls = installFetch(() => ({
      body: {
        result: { title: 'SUCCESS', status: 0 },
        trackingCode: '571000000098',
      },
    }));

    const refund = await harness.service.refundPayment({ payment });

    expect(refund.amount).toBe(ORDER_AMOUNT_RIAL);
    expect(refund.refundType).toBe(13);
    expect(refund.trackingCode).toBe('571000000098');
    expect(refund.status).toBe(PaymentRefundStatus.PENDING);
    expect(calls[0].url).toContain('/refunds?type=13');

    const body = JSON.parse(calls[0].init.body);

    expect(body).toMatchObject({
      amount: ORDER_AMOUNT_RIAL,
      saleTrackingCode: TRACKING_CODE,
    });
    expect(body.providerId).toMatch(/^ZP-REF-1-\d+$/);
  });

  it('عودت جزئی: مبلغ تومان ورودی را یک‌بار به ریال تبدیل می‌کند', async () => {
    const harness = makeHarness();
    makePendingPayment(harness, {
      id: 1,
      orderId: 10,
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 13,
    });

    const calls = installFetch(() => ({
      body: { result: { status: 0 }, trackingCode: '571000000098' },
    }));

    const result = await harness.service.refundOrder(10, {
      amount: 100_000, // تومان
    });

    expect(result.refunds).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body).amount).toBe(1_000_000); // ریال
  });

  it('مبلغ عودت بیشتر از مانده را رد می‌کند', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 5,
    });
    installFetch(() => ({ body: {} }));

    await expect(
      harness.service.refundPayment({
        payment,
        amount: ORDER_AMOUNT_RIAL + 1000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('استعلام، وضعیت عودت را به SUCCESS می‌برد', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 13,
    });

    installFetch(() => ({
      body: { result: { status: 0 }, trackingCode: '571000000098' },
    }));

    const refund = await harness.service.refundPayment({ payment });

    installFetch(() => ({
      body: {
        result: { title: 'SUCCESS', status: 0 },
        providerId: refund.providerId,
        trackingCode: '571000000098',
        status: 0,
        resultCode: 0,
        transferDate: 1592502763000,
        destinationType: 3,
      },
    }));

    const updated = await harness.service.inquireRefund(refund);

    expect(updated.status).toBe(PaymentRefundStatus.SUCCESS);
    expect(updated.destinationType).toBe(3);
    expect(updated.transferDate).toBe('1592502763000');
  });

  it('استعلام با کد 1121 عودت را FAILED می‌کند تا مانده آزاد شود', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 13,
    });

    installFetch(() => ({
      body: { result: { status: 0 }, trackingCode: '571000000098' },
    }));

    const refund = await harness.service.refundPayment({ payment });

    installFetch(() => ({
      status: 422,
      body: { result: { status: 1121, message: 'تراکنش یافت نشد' } },
    }));

    const updated = await harness.service.inquireRefund(refund);

    expect(updated.status).toBe(PaymentRefundStatus.FAILED);
    expect(updated.resultCode).toBe('1121');
  });

  it('خطای قطعی ثبت عودت را FAILED می‌کند و مبلغ را دوباره آزاد می‌گذارد', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 13,
    });

    installFetch(() => ({
      status: 422,
      body: { result: { status: 9035, message: 'Refund مجاز نیست' } },
    }));

    const refund = await harness.service.refundPayment({ payment });

    expect(refund.status).toBe(PaymentRefundStatus.FAILED);
    expect(refund.resultCode).toBe('9035');
  });

  it('عودت کامل تکراری ارسال نمی‌شود (idempotent)', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 13,
    });

    installFetch(() => ({
      body: { result: { status: 0 }, trackingCode: '571000000098' },
    }));

    await harness.service.refundPayment({ payment });
    const calls = installFetch(() => ({ body: {} }));

    const second = await harness.service.refundOrder(10);

    expect(second.refunds).toHaveLength(0);
    expect(second.messages[0]).toContain('قبلاً به‌طور کامل عودت شده است');
    expect(calls).toHaveLength(0);
  });

  it('در reconcile، عودت خودکار فقط برای پرداخت‌های سفارش لغوشده انجام می‌شود', async () => {
    const harness = makeHarness();

    const cancelledPayment = makePendingPayment(harness, {
      id: 1,
      orderId: 10,
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 13,
    });

    // کوئری، فقط پرداخت‌های سفارش لغوشده با ماندهٔ قابل عودت را برمی‌گرداند
    harness.setQueryRows([cancelledPayment]);

    const refundSpy = jest
      .spyOn(harness.service, 'refundOrder')
      .mockResolvedValue({ refunds: [], messages: [] });

    await harness.service.reconcileRefunds();

    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy).toHaveBeenCalledWith(10, expect.anything());
  });

  it('با DIGIPAY_AUTO_REFUND=false عودت خودکار انجام نمی‌شود', async () => {
    const harness = makeHarness({ config: { DIGIPAY_AUTO_REFUND: 'false' } });
    const cancelledPayment = makePendingPayment(harness, {
      id: 1,
      orderId: 10,
      status: PaymentStatus.SUCCESS,
      saleReferenceId: TRACKING_CODE,
      digipayPurchaseType: 13,
    });
    harness.setQueryRows([cancelledPayment]);

    const refundSpy = jest.spyOn(harness.service, 'refundOrder');

    await harness.service.reconcileRefunds();

    expect(refundSpy).not.toHaveBeenCalled();
  });
});

describe('DigipayPaymentService — همسان‌سازی پرداخت‌های معلق', () => {
  it('پرداخت بدون callback موفق را verify نمی‌کند', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      createdAt: new Date(Date.now() - 10 * 60_000),
    });
    const calls = installFetch(() => ({ body: {} }));

    await harness.service.reconcilePendingPayments();

    expect(calls).toHaveLength(0);
    expect(payment.status).toBe(PaymentStatus.PENDING);
  });

  it('پرداخت رهاشدهٔ قدیمی را EXPIRED می‌کند', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      createdAt: new Date(Date.now() - 25 * 60 * 60_000),
    });
    installFetch(() => ({ body: {} }));

    await harness.service.reconcilePendingPayments();

    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(payment.resCode).toBe('EXPIRED');
  });

  it('callback بدون فیلد result را هم برای verify در نظر می‌گیرد', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      createdAt: new Date(Date.now() - 10 * 60_000),
      gatewayResponse: {
        callback: {
          amount: String(ORDER_AMOUNT_RIAL),
          providerId: 'ORDER-10-1',
          trackingCode: TRACKING_CODE,
          // بدون result و بدون type (نسخهٔ کوتاه callback کیف پول)
        },
      },
      digipayPurchaseType: 11,
    });

    const calls = installFetch(() => ({
      body: {
        result: { status: 0, message: 'ok' },
        trackingCode: TRACKING_CODE,
        providerId: 'ORDER-10-1',
        amount: ORDER_AMOUNT_RIAL,
        paymentGateway: 3,
      },
    }));

    await harness.service.reconcilePendingPayments();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('type=11');
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
  });

  it('پرداخت با callback موفق ولی نوع نامشخص را هرگز EXPIRED نمی‌کند', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      createdAt: new Date(Date.now() - 25 * 60 * 60_000),
      gatewayResponse: {
        callback: {
          amount: String(ORDER_AMOUNT_RIAL),
          providerId: 'ORDER-10-1',
          trackingCode: TRACKING_CODE,
          result: 'SUCCESS',
          // بدون type و بدون نوع ذخیره‌شده روی پرداخت
        },
      },
      digipayPurchaseType: null,
    });

    const calls = installFetch(() => ({ body: {} }));

    await harness.service.reconcilePendingPayments();

    expect(calls).toHaveLength(0);
    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.resCode).toBe('0');
  });

  it('پرداخت با callback موفق را دوباره verify می‌کند', async () => {
    const harness = makeHarness();
    const payment = makePendingPayment(harness, {
      createdAt: new Date(Date.now() - 10 * 60_000),
      gatewayResponse: {
        callback: {
          amount: String(ORDER_AMOUNT_RIAL),
          providerId: 'ORDER-10-1',
          trackingCode: TRACKING_CODE,
          type: '13',
          result: 'SUCCESS',
        },
      },
    });

    const calls = installFetch(() => ({
      body: {
        result: { status: 0, message: 'ok' },
        trackingCode: TRACKING_CODE,
        providerId: 'ORDER-10-1',
        amount: ORDER_AMOUNT_RIAL,
        paymentGateway: 10,
      },
    }));

    await harness.service.reconcilePendingPayments();

    expect(calls).toHaveLength(1);
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
  });
});
