import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from 'src/order/entities/order.entity';

import {
  Payment,
  PaymentGateway,
  PaymentPurpose,
  PaymentStatus,
} from '../entities/payment.entity';
import { SnappPayError, SnappPayStatus } from '../snappay/snappay.client';
import { buildSnappPayCart } from '../snappay/snappay-cart.util';
import { SnappayPaymentService } from './snappay-payment.service';

const TX_ID = 'Z10TTEST123456';
const PAYMENT_TOKEN = 'snapp-payment-token';
const AMOUNT_IRR = 9_700_000;

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    status: OrderStatus.PENDING,
    user: { id: 1, phone: '09123456789' },
    items: [
      {
        id: 101,
        quantity: 2,
        price: 400_000,
        originalPrice: 500_000,
        variant: {
          product: { title: 'مانتو', categories: [{ name: 'پوشاک زنانه' }] },
          color: { name: 'مشکی' },
          size: { name: 'M' },
        },
      },
    ],
    totalPrice: 1_000_000,
    shippingCost: 170_000,
    discount: 200_000,
    finalPrice: 970_000,
    walletPayment: 0,
    ...overrides,
  } as never;
}

/** مخزن درون‌حافظه‌ای پرداخت‌ها با پشتیبانی از کوئری‌های استفاده‌شده در سرویس */
function makePaymentRepo() {
  const store = new Map<number, Payment>();
  let nextId = 1;

  const matches = (payment: Payment, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      const actual = (payment as never)[key];

      if (value && typeof value === 'object' && 'value' in value) {
        // FindOperator ‏Not(x)
        return actual !== value.value;
      }

      return actual === value;
    });

  return {
    store,
    create: jest.fn((data: Partial<Payment>) => ({ ...data }) as Payment),
    save: jest.fn((payment: Payment) => {
      if (!payment.id) {
        payment.id = nextId++;
      }
      store.set(payment.id, payment);
      return Promise.resolve(payment);
    }),
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      for (const payment of store.values()) {
        if (matches(payment, where)) {
          return Promise.resolve(payment);
        }
      }
      return Promise.resolve(null);
    }),
    find: jest.fn(() => Promise.resolve([] as Payment[])),
  };
}

function makeHarness(order: unknown = makeOrder(), realClient = false) {
  const paymentRepo = makePaymentRepo();

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
    adminCancelOrder: jest.fn(() => {
      (order as { status: OrderStatus }).status = OrderStatus.CANCELLED;
      return Promise.resolve(order);
    }),
  };

  const paymentGuard = {
    ensureOrderPayable: jest.fn(() => Promise.resolve(undefined)),
  };

  const configValues: Record<string, string> = {
    SNAPPAY_ENABLED: 'true',
    SNAPPAY_API_URL: 'https://snapp.example',
    SNAPPAY_CLIENT_ID: 'client',
    SNAPPAY_CLIENT_SECRET: 'secret',
    SNAPPAY_USERNAME: 'merchant',
    SNAPPAY_PASSWORD: 'password',
    APP_URL: 'https://shop.example',
  };
  const configService = {
    get: jest.fn((name: string) => configValues[name]),
  };

  const client = {
    eligible: jest.fn(
      (): Promise<{
        eligible: boolean;
        title_message?: string;
        description?: string;
      }> =>
        Promise.resolve({
          eligible: true,
          title_message: 'عنوان اسنپ‌پی',
          description: 'توضیح اسنپ‌پی',
        }),
    ),
    createPayment: jest.fn((_purchase?: unknown) =>
      Promise.resolve({
        paymentToken: PAYMENT_TOKEN,
        paymentPageUrl: 'https://pay.example/start',
      }),
    ),
    status: jest.fn(
      (): Promise<{
        transactionId: string;
        status: SnappPayStatus;
        amount: number;
      }> =>
        Promise.resolve({
          transactionId: TX_ID,
          status: 'PENDING',
          amount: AMOUNT_IRR,
        }),
    ),
    verify: jest.fn(() => Promise.resolve({ transactionId: TX_ID })),
    settle: jest.fn(() => Promise.resolve({ transactionId: TX_ID })),
    cancel: jest.fn(() => Promise.resolve({ transactionId: TX_ID })),
    update: jest.fn(() => Promise.resolve({ transactionId: TX_ID })),
    revert: jest.fn(() => Promise.resolve({ transactionId: TX_ID })),
  };

  const service = new SnappayPaymentService(
    configService as never,
    paymentRepo as never,
    ordersService as never,
    paymentGuard as never,
  );

  if (!realClient) {
    Object.defineProperty(service, 'getClient', { value: () => client });
  }

  return {
    service,
    client,
    paymentRepo,
    ordersService,
    paymentGuard,
    configValues,
    order: order as { status: OrderStatus },
  };
}

async function makePendingPayment(
  harness: ReturnType<typeof makeHarness>,
  overrides: Partial<Payment> = {},
): Promise<Payment> {
  const built = buildSnappPayCart({
    orderId: 10,
    lines: [
      {
        id: 101,
        name: 'مانتو',
        category: 'پوشاک زنانه',
        unitPriceToman: 500_000,
        quantity: 2,
      },
    ],
    shippingToman: 170_000,
    discountToman: 200_000,
    externalToman: 0,
    expectedPayableToman: 970_000,
    commissionType: 100,
  });

  const payment = {
    orderId: 10,
    purpose: PaymentPurpose.ORDER,
    walletChargeId: null,
    refId: PAYMENT_TOKEN,
    providerId: TX_ID,
    amount: AMOUNT_IRR,
    gateway: PaymentGateway.SNAPPAY,
    status: PaymentStatus.PENDING,
    resCode: 'PENDING',
    gatewayResponse: {
      snappay: {
        transactionId: TX_ID,
        paymentToken: PAYMENT_TOKEN,
        status: 'PENDING',
        purchase: {
          amount: built.amount,
          cartList: built.cartList,
          discountAmount: built.discountAmount,
          externalSourceAmount: built.externalSourceAmount,
          transactionId: TX_ID,
        },
      },
    },
    createdAt: new Date(),
    ...overrides,
  } as Payment;

  return harness.paymentRepo.save(payment);
}

describe('SnappayPaymentService', () => {
  it('hides the gateway (eligible=false) when SnappPay is not enabled', async () => {
    const harness = makeHarness();
    harness.configValues.SNAPPAY_ENABLED = 'false';

    await expect(
      harness.service.getEligibility(1, { amount: AMOUNT_IRR }),
    ).resolves.toEqual({ eligible: false });
    expect(harness.client.eligible).not.toHaveBeenCalled();
  });

  it('starts a payment: rechecks eligibility, persists the attempt and returns the pay URL', async () => {
    const harness = makeHarness();

    const result = await harness.service.requestPayment(10, 1);

    expect(result).toEqual({
      refId: PAYMENT_TOKEN,
      payUrl: 'https://pay.example/start',
    });
    expect(harness.paymentGuard.ensureOrderPayable).toHaveBeenCalled();
    expect(harness.client.eligible).toHaveBeenCalledWith(AMOUNT_IRR, undefined);

    const purchase = harness.client.createPayment.mock.calls[0][0] as {
      amount: number;
      transactionId: string;
      mobile: string;
      returnURL: string;
      cartList: unknown[];
      discountAmount: number;
      externalSourceAmount: number;
    };

    expect(purchase.amount).toBe(AMOUNT_IRR);
    expect(purchase.discountAmount).toBe(2_000_000);
    expect(purchase.externalSourceAmount).toBe(0);
    expect(purchase.mobile).toBe('09123456789');
    expect(purchase.returnURL).toBe(
      'https://shop.example/api/payment/callback/snappay',
    );
    expect(purchase.transactionId).toMatch(/^Z10T[A-Z0-9]+$/);

    const saved = [...harness.paymentRepo.store.values()][0];
    expect(saved.refId).toBe(PAYMENT_TOKEN);
    expect(saved.providerId).toBe(purchase.transactionId);
    expect(saved.gateway).toBe(PaymentGateway.SNAPPAY);
    expect(saved.status).toBe(PaymentStatus.PENDING);
    expect(Number(saved.amount)).toBe(AMOUNT_IRR);
  });

  it('refuses to start when the server-side eligibility recheck is false', async () => {
    const harness = makeHarness();
    harness.client.eligible.mockResolvedValue({ eligible: false });

    await expect(harness.service.requestPayment(10, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(harness.client.createPayment).not.toHaveBeenCalled();
    expect(harness.paymentRepo.store.size).toBe(0);
  });

  it('marks the persisted attempt FAILED when SnappPay definitively rejects the token request', async () => {
    const harness = makeHarness();
    harness.client.createPayment.mockRejectedValue(
      new SnappPayError('رد قطعی', 'provider', 400, '123'),
    );

    await expect(harness.service.requestPayment(10, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const saved = [...harness.paymentRepo.store.values()][0];
    expect(saved.status).toBe(PaymentStatus.FAILED);
    expect(saved.resCode).toBe('123');
  });

  it('verifies, settles and only then confirms the order on an OK callback', async () => {
    const harness = makeHarness();
    const payment = await makePendingPayment(harness);

    const result = await harness.service.handleCallback(payment, {
      transactionId: TX_ID,
      state: 'OK',
      amount: String(AMOUNT_IRR),
    });

    expect(result.success).toBe(true);
    expect(harness.client.verify).toHaveBeenCalledTimes(1);
    expect(harness.client.settle).toHaveBeenCalledTimes(1);
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
    expect(payment.resCode).toBe('SETTLE');
    expect(harness.ordersService.confirmOrderPayment).toHaveBeenCalledWith(10);
    expect(harness.order.status).toBe(OrderStatus.PAID);
  });

  it('treats a duplicated OK callback as idempotent (verify/settle are not repeated)', async () => {
    const harness = makeHarness();
    const payment = await makePendingPayment(harness);
    const callback = {
      transactionId: TX_ID,
      state: 'OK',
      amount: String(AMOUNT_IRR),
    };

    await harness.service.handleCallback(payment, callback);
    const second = await harness.service.handleCallback(payment, callback);

    expect(second.success).toBe(true);
    expect(harness.client.verify).toHaveBeenCalledTimes(1);
    expect(harness.client.settle).toHaveBeenCalledTimes(1);
    expect(harness.ordersService.confirmOrderPayment).toHaveBeenCalledTimes(1);
  });

  it('recovers from a verify timeout via status=VERIFY and proceeds to settle', async () => {
    const harness = makeHarness();
    const payment = await makePendingPayment(harness);

    harness.client.status
      .mockResolvedValueOnce({
        transactionId: TX_ID,
        status: 'PENDING',
        amount: AMOUNT_IRR,
      })
      .mockResolvedValueOnce({
        transactionId: TX_ID,
        status: 'VERIFY',
        amount: AMOUNT_IRR,
      });
    harness.client.verify.mockRejectedValue(
      new SnappPayError('ارتباط نامشخص', 'transport'),
    );

    const result = await harness.service.handleCallback(payment, {
      transactionId: TX_ID,
      state: 'OK',
      amount: String(AMOUNT_IRR),
    });

    expect(result.success).toBe(true);
    expect(harness.client.verify).toHaveBeenCalledTimes(1);
    expect(harness.client.settle).toHaveBeenCalledTimes(1);
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
  });

  it('treats status=SETTLE after an inconclusive settle as success without settling twice', async () => {
    const harness = makeHarness();
    const payment = await makePendingPayment(harness);

    harness.client.status
      .mockResolvedValueOnce({
        transactionId: TX_ID,
        status: 'PENDING',
        amount: AMOUNT_IRR,
      })
      .mockResolvedValueOnce({
        transactionId: TX_ID,
        status: 'SETTLE',
        amount: AMOUNT_IRR,
      });
    harness.client.settle.mockRejectedValue(
      new SnappPayError('ارتباط نامشخص', 'transport'),
    );

    const result = await harness.service.handleCallback(payment, {
      transactionId: TX_ID,
      state: 'OK',
      amount: String(AMOUNT_IRR),
    });

    expect(result.success).toBe(true);
    expect(harness.client.settle).toHaveBeenCalledTimes(1);
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
  });

  it('does not verify when the callback amount does not match the stored amount', async () => {
    const harness = makeHarness();
    const payment = await makePendingPayment(harness);

    const result = await harness.service.handleCallback(payment, {
      transactionId: TX_ID,
      state: 'OK',
      amount: '1000',
    });

    expect(result).toMatchObject({ success: false, pending: true });
    expect(harness.client.verify).not.toHaveBeenCalled();
    expect(payment.status).toBe(PaymentStatus.PENDING);
  });

  it('reverts and fails the order on a FAILED callback', async () => {
    const harness = makeHarness();
    const payment = await makePendingPayment(harness);

    const result = await harness.service.handleCallback(payment, {
      transactionId: TX_ID,
      state: 'FAILED',
      amount: String(AMOUNT_IRR),
    });

    expect(result.success).toBe(false);
    expect(harness.client.revert).toHaveBeenCalledWith(PAYMENT_TOKEN);
    expect(harness.client.verify).not.toHaveBeenCalled();
    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(harness.ordersService.failOrderPayment).toHaveBeenCalledWith(10);
    expect(harness.order.status).toBe(OrderStatus.CANCELLED);
  });

  it('revives a payment that the shared guard had marked STALE but the user actually paid', async () => {
    const harness = makeHarness();
    const payment = await makePendingPayment(harness, {
      status: PaymentStatus.FAILED,
      resCode: 'STALE',
    });

    const result = await harness.service.handleCallback(payment, {
      transactionId: TX_ID,
      state: 'OK',
      amount: String(AMOUNT_IRR),
    });

    expect(result.success).toBe(true);
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
    expect(harness.ordersService.confirmOrderPayment).toHaveBeenCalledWith(10);
  });

  it('reverts a duplicate payment when the order was already paid through another payment', async () => {
    const harness = makeHarness(makeOrder({ status: OrderStatus.PAID }));
    const payment = await makePendingPayment(harness);

    await harness.paymentRepo.save({
      orderId: 10,
      purpose: PaymentPurpose.ORDER,
      refId: 'other-authority',
      providerId: null,
      amount: AMOUNT_IRR,
      gateway: PaymentGateway.ZARINPAL,
      status: PaymentStatus.SUCCESS,
      gatewayResponse: null,
      createdAt: new Date(),
    } as Payment);

    const result = await harness.service.handleCallback(payment, {
      transactionId: TX_ID,
      state: 'OK',
      amount: String(AMOUNT_IRR),
    });

    expect(result.success).toBe(false);
    expect(harness.client.verify).not.toHaveBeenCalled();
    expect(harness.client.revert).toHaveBeenCalledWith(PAYMENT_TOKEN);
    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(payment.resCode).toBe('DUPLICATE_REVERTED');
    expect(harness.ordersService.confirmOrderPayment).not.toHaveBeenCalled();
    expect(harness.ordersService.failOrderPayment).not.toHaveBeenCalled();
  });

  it('cancels a settled payment for an admin and cancels the order afterwards', async () => {
    const harness = makeHarness(makeOrder({ status: OrderStatus.PAID }));
    const payment = await makePendingPayment(harness, {
      status: PaymentStatus.SUCCESS,
      resCode: 'SETTLE',
    });
    harness.client.status.mockResolvedValue({
      transactionId: TX_ID,
      status: 'SETTLE',
      amount: AMOUNT_IRR,
    });

    await expect(
      harness.service.adminCancelPayment(payment.id, { confirm: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.client.cancel).not.toHaveBeenCalled();

    const result = await harness.service.adminCancelPayment(payment.id, {
      confirm: true,
    });

    expect(result).toMatchObject({ cancelled: true, orderCancelled: true });
    expect(harness.client.cancel).toHaveBeenCalledWith(PAYMENT_TOKEN);
    expect(harness.ordersService.adminCancelOrder).toHaveBeenCalledWith(
      10,
      expect.any(String),
    );
    expect(
      (payment.gatewayResponse as { snappay: { cancel?: unknown } }).snappay
        .cancel,
    ).toBeTruthy();
  });

  it('updates a settled payment to a smaller amount for an admin', async () => {
    const harness = makeHarness(makeOrder({ status: OrderStatus.PAID }));
    const payment = await makePendingPayment(harness, {
      status: PaymentStatus.SUCCESS,
      resCode: 'SETTLE',
    });
    harness.client.status.mockResolvedValue({
      transactionId: TX_ID,
      status: 'SETTLE',
      amount: AMOUNT_IRR,
    });

    const result = await harness.service.adminUpdatePayment(payment.id, {
      confirm: true,
      items: [{ orderItemId: 101, count: 1 }],
    });

    // یک قلم ۵۰۰ هزار تومانی + ارسال ۱۷۰ هزار − تخفیف ۲۰۰ هزار = ۴۷۰ هزار تومان
    expect(result).toMatchObject({
      previousAmount: AMOUNT_IRR,
      amount: 4_700_000,
    });
    expect(harness.client.update).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 4_700_000,
        paymentToken: PAYMENT_TOKEN,
      }),
    );
    expect(Number(payment.amount)).toBe(4_700_000);
  });
});

describe('SnappayPaymentService with the real SnappPayClient (contract flow)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs eligibility -> token -> callback -> verify -> settle against a fake SnappPay API', async () => {
    const harness = makeHarness(makeOrder(), true);

    const jsonResponse = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    let providerState: 'PENDING' | 'VERIFY' | 'SETTLE' = 'PENDING';
    let purchaseBody: Record<string, any> | null = null;
    let purchaseTransactionId = '';
    const authHeaders: (string | undefined)[] = [];

    const route = (url: string, init?: RequestInit): Response => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      authHeaders.push(headers.Authorization);

      if (url.endsWith('/api/online/v1/oauth/token')) {
        const body = new URLSearchParams(
          typeof init?.body === 'string' ? init.body : '',
        );
        expect(headers.Authorization).toBe(
          `Basic ${Buffer.from('client:secret').toString('base64')}`,
        );
        expect(body.get('grant_type')).toBe('password');
        expect(body.get('scope')).toBe('online-merchant');
        expect(body.get('username')).toBe('merchant');

        return jsonResponse({ access_token: 'jwt-token', expires_in: 3600 });
      }

      if (url.includes('/api/online/offer/v1/eligible')) {
        expect(url).toContain(`amount=${AMOUNT_IRR}`);
        return jsonResponse({
          successful: true,
          response: {
            eligible: true,
            title_message: 'خرید اقساطی با اسنپ‌پی',
            description: 'در ۴ قسط پرداخت کنید',
          },
        });
      }

      if (url.endsWith('/api/online/payment/v1/token')) {
        purchaseBody = JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}',
        );
        purchaseTransactionId = String(purchaseBody?.transactionId ?? '');
        return jsonResponse({
          successful: true,
          response: {
            paymentToken: PAYMENT_TOKEN,
            paymentPageUrl: 'https://pay.example/start',
          },
        });
      }

      if (url.includes('/api/online/payment/v1/status')) {
        expect(url).toContain(
          `paymentToken=${encodeURIComponent(PAYMENT_TOKEN)}`,
        );
        return jsonResponse({
          successful: true,
          response: {
            transactionId: purchaseTransactionId,
            status: providerState,
            amount: AMOUNT_IRR,
          },
        });
      }

      if (url.endsWith('/api/online/payment/v1/verify')) {
        expect(
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
        ).toEqual({
          paymentToken: PAYMENT_TOKEN,
        });
        providerState = 'VERIFY';
        return jsonResponse({
          successful: true,
          response: { transactionId: purchaseTransactionId },
        });
      }

      if (url.endsWith('/api/online/payment/v1/settle')) {
        providerState = 'SETTLE';
        return jsonResponse({
          successful: true,
          response: { transactionId: purchaseTransactionId },
        });
      }

      throw new Error(`Unexpected SnappPay URL: ${url}`);
    };

    jest
      .spyOn(global, 'fetch')
      .mockImplementation((input, init) =>
        Promise.resolve(
          route(typeof input === 'string' ? input : input.url, init),
        ),
      );

    const started = await harness.service.requestPayment(10, 1);

    expect(started).toEqual({
      refId: PAYMENT_TOKEN,
      payUrl: 'https://pay.example/start',
    });

    // قرارداد دقیق درخواست توکن مطابق مستند و کالکشن Postman
    expect(purchaseBody).toMatchObject({
      amount: AMOUNT_IRR,
      discountAmount: 2_000_000,
      externalSourceAmount: 0,
      mobile: '09123456789',
      returnURL: 'https://shop.example/api/payment/callback/snappay',
      cartList: [
        {
          cartId: 10,
          cartItems: [
            {
              id: 101,
              amount: 5_000_000,
              category: 'پوشاک زنانه',
              count: 2,
              commissionType: 100,
            },
          ],
          isShipmentIncluded: false,
          isTaxIncluded: true,
          shippingAmount: 1_700_000,
          taxAmount: 0,
          totalAmount: 11_700_000,
        },
      ],
    });
    expect(purchaseBody?.forcedPaymentMethodTypes).toBeUndefined();
    expect(authHeaders).toContain('Bearer jwt-token');

    const payment = [...harness.paymentRepo.store.values()][0];
    expect(payment.providerId).toBe(purchaseTransactionId);

    // کاربر در اسنپ‌پی پرداخت کرده و نتیجه به returnURL برگشته است
    const result = await harness.service.handleCallback(payment, {
      transactionId: purchaseTransactionId,
      state: 'OK',
      amount: String(AMOUNT_IRR),
    });

    expect(result.success).toBe(true);
    expect(providerState).toBe('SETTLE');
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
    expect(harness.ordersService.confirmOrderPayment).toHaveBeenCalledWith(10);
    expect(harness.order.status).toBe(OrderStatus.PAID);
  });
});
