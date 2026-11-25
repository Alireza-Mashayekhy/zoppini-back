import { BadRequestException } from '@nestjs/common';
import { generateKeyPairSync } from 'crypto';
import { of } from 'rxjs';

import { RahkaranService } from './rahkaran.service';

const BASE_URL = 'https://rahkaran.test';

function capturingLogger() {
  const lines: { level: string; message: string }[] = [];

  const capture =
    (level: string) =>
    (message: unknown, ...rest: unknown[]) => {
      lines.push({
        level,
        message: [message, ...rest]
          .map(part => (typeof part === 'string' ? part : JSON.stringify(part)))
          .join(' | '),
      });
    };

  return {
    lines,
    logger: {
      log: capture('log'),
      error: capture('error'),
      warn: capture('warn'),
      debug: capture('debug'),
      verbose: capture('verbose'),
    },
  };
}

describe('RahkaranService invoice flow logging', () => {
  const PASSWORD = 'secret-password';

  let httpService: { request: jest.Mock };
  let service: RahkaranService;
  let logSink: ReturnType<typeof capturingLogger>;

  const order = {
    id: 42,
    orderNumber: 'ORD-12345678-1234',
    finalPrice: 1_250_000,
    shippingCost: 0,
    user: { phone: '09120000000' },
    items: [
      {
        quantity: 2,
        price: 625_000,
        variant: { sku: 'SKU-1' },
      },
    ],
  };

  beforeEach(() => {
    const configService = {
      get: (key: string) =>
        ({
          RAHKARAN_BASE_URL: BASE_URL,
          RAHKARAN_USERNAME: 'zoppini-user',
          RAHKARAN_PASSWORD: PASSWORD,
          RAHKARAN_MACHINE_NAME: 'MACHINE-1',
          RAHKARAN_AUTO_LOGIN: 'false',
        })[key],
    };

    httpService = { request: jest.fn() };

    service = new RahkaranService(
      httpService as any,
      configService as any,
      {} as any,
    );

    logSink = capturingLogger();
    (service as any).logger = logSink.logger;
  });

  function stubAuthenticated() {
    (service as any).state = {
      sessionId: 'sess-123',
      cookie: 'auth-cookie=value',
      cashRegister: {
        cashierId: 1,
        userId: 1,
        cashRegisterId: 10,
        cashierTitle: 'صندوق‌دار',
        cashRegisterTitle: 'صندوق',
        retailSessionId: 99,
        sessionNumber: '99',
        retailInteriorSectionId: null,
        retailInteriorSectionTitle: '',
        retailInteriorSectionType: 0,
        hasSupervisor: false,
        retailShopID: 5,
        kioskIP: null,
      },
      authenticatedAt: new Date(),
      lastTickAt: null,
    };
  }

  function mockInvoiceFlowHttp() {
    httpService.request.mockImplementation((config: any) => {
      const url: string = config.url;

      if (url.includes('/CustomerService.svc/customer?')) {
        return of({
          data: {
            result: [{ Id: 77, mobile: '09120000000' }],
            metadata: { isSuccessfull: true, errorMessage: null },
          },
          headers: {},
        });
      }

      if (url.includes('getProductByBarcode')) {
        return of({
          data: {
            result: {
              product: {
                productId: 501,
                RetailUnitRef: 2,
                unitRef: 1,
                fee: 6_250_000,
                productName: 'انگشتر',
              },
            },
            metadata: { isSuccessfull: true, errorMessage: null },
          },
          headers: {},
        });
      }

      if (url.includes('GetProduct?id=83467')) {
        return of({
          data: {
            result: {
              productId: 83467,
              productName: 'هزینه ارسال',
              RetailUnitRef: 3,
              fee: 2_500_000,
            },
            metadata: { isSuccessfull: true, errorMessage: null },
          },
          headers: {},
        });
      }

      if (url.includes('GetRemainingQuantityInfo')) {
        return of({
          data: {
            result: [
              {
                StoreID: 23,
                StoreName: 'هدیش مال',
                RemainingQuantity: 5,
                RetailReserveQuantity: 0,
                InventoryReserveQuantity: 0,
                InventoryPhysicalQuantity: 5,
                AllowNegativeSales: false,
                MaxNegativeSales: null,
                AllowNegativeReserves: false,
                MaxNegativeReserves: null,
              },
              {
                StoreID: 20,
                StoreName: 'خرده‌فروشی',
                RemainingQuantity: 3,
                RetailReserveQuantity: 0,
                InventoryReserveQuantity: 0,
                InventoryPhysicalQuantity: 3,
                AllowNegativeSales: false,
                MaxNegativeSales: null,
                AllowNegativeReserves: false,
                MaxNegativeReserves: null,
              },
            ],
            metadata: { isSuccessfull: true, errorMessage: null },
          },
          headers: {},
        });
      }

      if (url.includes('SaveInvoice')) {
        return of({
          data: {
            result: { id: 900, number: 'INV-900' },
            metadata: { isSuccessfull: true, errorMessage: null },
          },
          headers: {},
        });
      }

      return of({ data: {}, headers: {} });
    });
  }

  it('adds one priced-by-catalog shipping product without adding to the receipt again', async () => {
    stubAuthenticated();
    mockInvoiceFlowHttp();
    const chargedOrder = {
      ...order,
      shippingCost: 250_000,
      finalPrice: 1_500_000,
    };
    await service.syncOrderToRahkaran(chargedOrder);
    const save = httpService.request.mock.calls
      .map(call => call[0])
      .find(config => config.url.includes('SaveInvoice'));
    expect(
      save.data.document.items.filter((item: any) => item.productId === 83467),
    ).toEqual([
      expect.objectContaining({ productId: 83467, quantity: 1, unitId: 3 }),
    ]);
    expect(save.data.receipts[0].amount).toBe(15_000_000);
    expect(chargedOrder.items).toHaveLength(1);
  });

  it('does not add a shipping line for free or postpaid orders', async () => {
    stubAuthenticated();
    mockInvoiceFlowHttp();
    await service.syncOrderToRahkaran({ ...order, shippingCost: 0 });
    const calls = httpService.request.mock.calls.map(call => call[0]);
    const save = calls.find(config => config.url.includes('SaveInvoice'));
    expect(
      save.data.document.items.some((item: any) => item.productId === 83467),
    ).toBe(false);
    expect(
      calls.some(config => config.url.includes('GetProduct?id=83467')),
    ).toBe(false);
  });

  it('refuses to post an invoice when Rahkaran shipping price differs from the frozen order', async () => {
    stubAuthenticated();
    mockInvoiceFlowHttp();
    jest.spyOn(service, 'getRetailProduct').mockResolvedValue({
      productId: 83467,
      RetailUnitRef: 3,
      fee: 1_700_000,
    } as any);
    await expect(
      service.syncOrderToRahkaran({ ...order, shippingCost: 250_000 }),
    ).rejects.toThrow('مطابقت ندارد');
    expect(
      httpService.request.mock.calls.some(call =>
        call[0].url.includes('SaveInvoice'),
      ),
    ).toBe(false);
  });

  it('logs the whole invoice registration with one correlationId and masked mobile', async () => {
    stubAuthenticated();
    mockInvoiceFlowHttp();

    const invoice = await service.syncOrderToRahkaran(order, {
      correlationId: 'rah-inv-test-1',
      attempt: 1,
    });

    expect(invoice).toMatchObject({ id: 900, number: 'INV-900' });

    const events = logSink.lines
      .filter(line => line.message.includes('rahkaran.invoice.'))
      .map(line => {
        try {
          return JSON.parse(line.message);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // گام‌های کلیدی فرآیند با همان correlationId لاگ شده‌اند
    const startEvent = events.find(
      e => e.event === 'rahkaran.invoice.sync.start',
    );
    const completedEvent = events.find(
      e => e.event === 'rahkaran.invoice.sync.completed',
    );

    expect(startEvent).toMatchObject({
      correlationId: 'rah-inv-test-1',
      orderId: 42,
      orderNumber: 'ORD-12345678-1234',
      customerMobile: '0912****000',
    });

    expect(completedEvent).toMatchObject({
      correlationId: 'rah-inv-test-1',
      orderId: 42,
      invoiceId: 900,
      invoiceNumber: 'INV-900',
    });

    expect(
      events.find(e => e.event === 'rahkaran.invoice.customer_resolved'),
    ).toBeTruthy();
    expect(
      events.find(e => e.event === 'rahkaran.invoice.item_prepared'),
    ).toBeTruthy();
    expect(
      events.find(e => e.event === 'rahkaran.invoice.create.success'),
    ).toBeTruthy();

    // همهٔ رویدادهای این درخواست correlationId یکسان دارند
    events.forEach(e => {
      expect(e.correlationId).toBe('rah-inv-test-1');
    });

    // شمارهٔ کامل موبایل در هیچ لاگی افشا نشده است
    const allLogs = logSink.lines.map(l => l.message).join('\n');
    expect(allLogs).not.toContain('09120000000');
  });

  it('logs the failure stage and Rahkaran error message on rejection', async () => {
    stubAuthenticated();
    mockInvoiceFlowHttp();

    httpService.request.mockImplementation((config: any) => {
      const url: string = config.url;

      if (url.includes('SaveInvoice')) {
        return of({
          data: {
            result: null,
            metadata: {
              isSuccessfull: false,
              errorMessage: 'موجودی کالا کافی نیست',
            },
          },
          headers: {},
        });
      }

      if (url.includes('/CustomerService.svc/customer?')) {
        return of({
          data: {
            result: [{ Id: 77, mobile: '09120000000' }],
            metadata: { isSuccessfull: true, errorMessage: null },
          },
          headers: {},
        });
      }

      if (url.includes('getProductByBarcode')) {
        return of({
          data: {
            result: {
              product: {
                productId: 501,
                RetailUnitRef: 2,
                unitRef: 1,
                fee: 6_250_000,
                productName: 'انگشتر',
              },
            },
            metadata: { isSuccessfull: true, errorMessage: null },
          },
          headers: {},
        });
      }

      if (url.includes('GetRemainingQuantityInfo')) {
        return of({
          data: {
            result: [
              {
                StoreID: 23,
                StoreName: 'هدیش مال',
                RemainingQuantity: 5,
                RetailReserveQuantity: 0,
                InventoryReserveQuantity: 0,
                InventoryPhysicalQuantity: 5,
                AllowNegativeSales: false,
                MaxNegativeSales: null,
                AllowNegativeReserves: false,
                MaxNegativeReserves: null,
              },
            ],
            metadata: { isSuccessfull: true, errorMessage: null },
          },
          headers: {},
        });
      }

      return of({ data: {}, headers: {} });
    });

    await expect(
      service.syncOrderToRahkaran(order, { correlationId: 'rah-inv-fail-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const rejected = logSink.lines
      .map(l => {
        try {
          return JSON.parse(l.message);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .find((e: any) => e.event === 'rahkaran.invoice.create.rejected');

    expect(rejected).toMatchObject({
      correlationId: 'rah-inv-fail-1',
      orderId: 42,
      stage: 'save_invoice',
      rahkaranError: 'موجودی کالا کافی نیست',
    });

    const failed = logSink.lines
      .map(l => {
        try {
          return JSON.parse(l.message);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .find((e: any) => e.event === 'rahkaran.invoice.sync.failed');

    expect(failed).toMatchObject({
      correlationId: 'rah-inv-fail-1',
      orderId: 42,
      stage: 'save_invoice',
    });
    expect(failed.error.message).toContain('موجودی کالا کافی نیست');
  });

  it('never logs the Rahkaran password during login', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 512 });
    const jwk = publicKey.export({ format: 'jwk' }) as {
      n: string;
      e: string;
    };

    const modulusHex = Buffer.from(jwk.n, 'base64url').toString('hex');
    const exponentHex = Buffer.from(jwk.e, 'base64url').toString('hex');

    httpService.request.mockImplementation((config: any) => {
      const url: string = config.url;

      if (url.includes('AuthenticationService.svc/session')) {
        return of({
          data: { id: 'sess-abc', rsa: { M: modulusHex, E: exponentHex } },
          headers: {},
        });
      }

      if (url.includes('AuthenticationService.svc/login')) {
        return of({
          data: {},
          headers: { 'set-cookie': ['auth-cookie=value; path=/'] },
        });
      }

      if (url.includes('DesktopCashierLogin')) {
        return of({
          data: {
            metadata: { isSuccessfull: true, errorMessage: null },
            result: {
              cashRegister: {
                cashierId: 1,
                userId: 1,
                cashRegisterId: 10,
                cashierTitle: 'صندوق‌دار',
                cashRegisterTitle: 'صندوق',
                retailSessionId: 99,
                sessionNumber: '99',
                retailInteriorSectionId: null,
                retailInteriorSectionTitle: '',
                retailInteriorSectionType: 0,
                hasSupervisor: false,
                retailShopID: 5,
                kioskIP: null,
              },
            },
          },
          headers: {},
        });
      }

      return of({ data: {}, headers: {} });
    });

    await service.login();

    const allLogs = logSink.lines.map(l => l.message).join('\n');

    expect(service.isAuthenticated()).toBe(true);
    expect(allLogs).not.toContain(PASSWORD);
    expect(allLogs).not.toContain('sess-abc');
    // کوکی لاگ نشده است
    expect(allLogs).not.toContain('auth-cookie=value');
  });
});
