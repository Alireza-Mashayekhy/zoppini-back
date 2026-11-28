import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OrderStatus } from 'src/order/entities/order.entity';

import { RahkaranInvoiceSyncStatus } from './entities/rahkaran-invoice-sync.entity';
import {
  addToCartShortageMessage,
  aggregateRequirements,
  checkoutShortageMessage,
  computeSellable,
  normalizeSku,
  parseRemainingQuantity,
  RahkaranStockService,
  readStockConfig,
  STOCK_ERROR_CODES,
  StockVerificationUnavailableError,
} from './rahkaran-stock.service';

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

type FakeVariant = {
  id: number;
  sku: string | null;
  stock: number;
  stockRetail: number;
  stockHadishMall: number;
  productId: number;
  product: { title: string };
  color: { name: string } | null;
  size: { name: string } | null;
};

const variant = (
  id: number,
  sku: string | null,
  title: string,
  color = 'مشکی',
  size = 'L',
  stock = 0,
): FakeVariant => ({
  id,
  sku,
  stock,
  stockRetail: 0,
  stockHadishMall: 0,
  productId: id * 10,
  product: { title },
  color: { name: color },
  size: { name: size },
});

const quantityRows = (hadishMall: unknown, retail: unknown) => [
  { StoreID: 23, StoreName: 'هدیش مال', RemainingQuantity: hadishMall },
  { StoreID: 20, StoreName: 'خرده‌فروشی', RemainingQuantity: retail },
  // انبار دیگری که جزو موجودی قابل فروش سایت نیست
  { StoreID: 99, StoreName: 'انبار مرکزی', RemainingQuantity: 500 },
];

interface Harness {
  service: RahkaranStockService;
  rahkaran: {
    getRetailProductByBarcode: jest.Mock;
    getRemainingQuantityInfo: jest.Mock;
  };
  variants: Map<number, FakeVariant>;
  updates: Array<Record<string, unknown>>;
  transaction: jest.Mock;
  pendingCalls: Array<{ ids: number[]; excludeUserId?: number }>;
  setStock: (sku: string, hadishMall: unknown, retail: unknown) => void;
  pending: Map<number, { paidNotInvoiced: number; softReserved: number }>;
  botEvents: { evaluateVariantStockTransitions: jest.Mock };
}

function makeHarness(
  variantList: FakeVariant[],
  config: Record<string, string> = {},
): Harness {
  const variants = new Map(variantList.map(v => [v.id, { ...v }]));
  const skuToProductId = new Map<string, number>();
  const stockByProductId = new Map<number, unknown[]>();
  let nextProductId = 5000;

  const setStock = (sku: string, hadishMall: unknown, retail: unknown) => {
    if (!skuToProductId.has(sku)) skuToProductId.set(sku, nextProductId++);
    stockByProductId.set(
      skuToProductId.get(sku)!,
      quantityRows(hadishMall, retail),
    );
  };

  const rahkaran = {
    getRetailProductByBarcode: jest.fn((sku: string) => {
      const productId = skuToProductId.get(sku);
      return Promise.resolve(
        productId ? { product: { productId, productName: sku } } : null,
      );
    }),
    getRemainingQuantityInfo: jest.fn((productId: number): Promise<unknown> =>
      Promise.resolve(stockByProductId.get(productId) ?? []),
    ),
  };

  const variantRepo = {
    find: jest.fn(({ where }: any) => {
      const ids: number[] = where.id.value ?? where.id._value;
      return Promise.resolve(
        ids
          .map(id => variants.get(id))
          .filter(Boolean)
          .map(v => ({ ...v })),
      );
    }),
  };

  const updates: Array<Record<string, unknown>> = [];
  const lockQb: any = {
    setLock: jest.fn(() => lockQb),
    where: jest.fn((_sql: string, params: { ids: number[] }) => {
      lockQb.ids = params.ids;
      return lockQb;
    }),
    orderBy: jest.fn(() => lockQb),
    getMany: jest.fn(() =>
      Promise.resolve(
        (lockQb.ids as number[]).map(id => ({ ...variants.get(id)! })),
      ),
    ),
  };
  const manager = {
    getRepository: jest.fn(() => ({ createQueryBuilder: () => lockQb })),
    update: jest.fn((_entity: unknown, where: any, values: any) => {
      updates.push({ id: where.id, ...values });
      Object.assign(variants.get(where.id)!, values);
      return Promise.resolve();
    }),
  };
  const transaction = jest.fn((cb: (m: unknown) => unknown) =>
    Promise.resolve(cb(manager)),
  );

  const configService = {
    get: (key: string) =>
      ({
        RAHKARAN_STOCK_CHECK_DEADLINE_MS: '1000',
        RAHKARAN_STOCK_CHECK_REQUEST_TIMEOUT_MS: '500',
        ...config,
      })[key],
  };
  const botEvents = {
    evaluateVariantStockTransitions: jest.fn().mockResolvedValue(0),
  };

  const service = new RahkaranStockService(
    rahkaran as never,
    variantRepo as never,
    { transaction } as never,
    configService as never,
    botEvents as never,
  );

  const pending = new Map<
    number,
    { paidNotInvoiced: number; softReserved: number }
  >();
  const pendingCalls: Harness['pendingCalls'] = [];
  jest
    .spyOn(service as any, 'loadPendingDeductions')
    .mockImplementation((...args: unknown[]) => {
      const [, ids, excludeUserId] = args as [unknown, number[], number?];
      pendingCalls.push({ ids, excludeUserId });
      return Promise.resolve(
        new Map(
          ids.filter(id => pending.has(id)).map(id => [id, pending.get(id)!]),
        ),
      );
    });

  return {
    service,
    rahkaran,
    variants,
    updates,
    transaction,
    pendingCalls,
    setStock,
    pending,
    botEvents,
  };
}

async function catchError(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

beforeAll(() => {
  // لاگ‌های عمدی خطا خروجی تست را شلوغ نکنند
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

// ------------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------------

describe('stock helpers', () => {
  it('sums duplicate cart rows of the same variant (regular + gift row)', () => {
    const totals = aggregateRequirements([
      { variantId: 1, quantity: 2 },
      { variantId: 2, quantity: 1 },
      { variantId: 1, quantity: 1 },
      { variantId: 3, quantity: 0 },
    ]);
    expect([...totals]).toEqual([
      [1, 3],
      [2, 1],
    ]);
  });

  it('uses Hadish Mall + Retail only, treats a missing warehouse as zero, floors fractions', () => {
    expect(parseRemainingQuantity(quantityRows(2, 3) as never)).toEqual({
      hadishMall: 2,
      retail: 3,
      total: 5,
    });
    expect(
      parseRemainingQuantity([{ StoreID: 20, RemainingQuantity: 4 }] as never),
    ).toEqual({ hadishMall: 0, retail: 4, total: 4 });
    expect(
      computeSellable({
        rahkaranTotal: 2.6,
        paidNotInvoiced: 0,
        softReserved: 0,
      }),
    ).toEqual({ siteStock: 2, available: 2 });
  });

  it('rejects an empty or non-numeric Rahkaran answer as unreliable', () => {
    expect(() => parseRemainingQuantity([])).toThrow(
      StockVerificationUnavailableError,
    );
    expect(() => parseRemainingQuantity(null)).toThrow(
      StockVerificationUnavailableError,
    );
    expect(() =>
      parseRemainingQuantity(quantityRows('abc', 1) as never),
    ).toThrow(StockVerificationUnavailableError);
  });

  it('site stock excludes paid-but-not-invoiced units; soft reservations only reduce availability', () => {
    expect(
      computeSellable({
        rahkaranTotal: 5,
        paidNotInvoiced: 2,
        softReserved: 1,
      }),
    ).toEqual({ siteStock: 3, available: 2 });
    expect(
      computeSellable({
        rahkaranTotal: 1,
        paidNotInvoiced: 3,
        softReserved: 0,
      }),
    ).toEqual({ siteStock: 0, available: 0 });
  });

  it('normalizes SKUs like the daily sync (trim + Persian/Arabic digits)', () => {
    expect(normalizeSku(' ۱۲۳٤٥ ')).toBe('12345');
    expect(normalizeSku(null)).toBe('');
  });

  it('is enabled by default and only disabled by an explicit "false"', () => {
    expect(readStockConfig(() => undefined).enabled).toBe(true);
    expect(
      readStockConfig(key =>
        key === 'RAHKARAN_STOCK_CHECK_ENABLED' ? 'FALSE' : undefined,
      ).enabled,
    ).toBe(false);
  });

  it('builds clear Persian messages', () => {
    expect(
      addToCartShortageMessage({
        productTitle: 'پیراهن کتان',
        variantLabel: 'آبی / L',
        available: 3,
        inCart: 2,
      }),
    ).toBe(
      'امکان افزودن تعداد بیشتری از «پیراهن کتان – آبی / L» وجود ندارد. موجودی قابل خرید ۳ عدد است و ۲ عدد آن در سبد خرید شماست.',
    );
    expect(
      addToCartShortageMessage({
        productTitle: 'پیراهن کتان',
        variantLabel: null,
        available: 0,
        inCart: 0,
      }),
    ).toBe('«پیراهن کتان» در حال حاضر موجود نیست.');
    expect(
      checkoutShortageMessage(
        [
          {
            variantId: 1,
            productId: 1,
            productTitle: 'شلوار',
            variantLabel: 'مشکی / 32',
            requested: 2,
            available: 1,
          },
          {
            variantId: 2,
            productId: 2,
            productTitle: 'کت',
            variantLabel: 'سرمه‌ای / M',
            requested: 1,
            available: 0,
          },
        ],
        'checkout',
      ),
    ).toBe(
      'موجودی برخی کالاهای سبد خرید کافی نیست. لطفاً سبد خود را اصلاح کنید: «شلوار – مشکی / 32»: درخواستی ۲ عدد، موجود ۱ عدد؛ «کت – سرمه‌ای / M»: ناموجود',
    );
  });
});

// ------------------------------------------------------------------
// Stage 1: add to cart
// ------------------------------------------------------------------

describe('RahkaranStockService — add to cart', () => {
  it('sufficient stock: passes and writes the live Rahkaran stock to the site', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن', 'آبی', 'L', 9)]);
    h.setStock('SKU-1', 2, 3);

    const result = await h.service.assertCanAddToCart({
      variantId: 1,
      requestedTotal: 5,
      inCart: 3,
    });

    expect(result).toEqual(
      expect.objectContaining({ available: 5, requested: 5, sufficient: true }),
    );
    expect(h.updates).toEqual([
      { id: 1, stock: 5, stockRetail: 3, stockHadishMall: 2 },
    ]);
    expect(h.botEvents.evaluateVariantStockTransitions).toHaveBeenCalledWith([
      expect.objectContaining({ variantId: 1, oldStock: 9, newStock: 5 }),
    ]);
  });

  it('insufficient stock (cart quantity + new quantity): 409 with Persian message, site stock still updated', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن', 'آبی', 'L', 10)]);
    h.setStock('SKU-1', 1, 2); // 3 قابل فروش

    const error = await catchError(
      h.service.assertCanAddToCart({
        variantId: 1,
        requestedTotal: 4, // ۲ در سبد + ۲ جدید
        inCart: 2,
      }),
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual(
      expect.objectContaining({
        code: STOCK_ERROR_CODES.INSUFFICIENT,
        message:
          'امکان افزودن تعداد بیشتری از «پیراهن – آبی / L» وجود ندارد. موجودی قابل خرید ۳ عدد است و ۲ عدد آن در سبد خرید شماست.',
        items: [
          expect.objectContaining({
            variantId: 1,
            requested: 4,
            available: 3,
            inCart: 2,
          }),
        ],
      }),
    );
    // موجودی سایت مطابق راهکاران اصلاح شد (۱۰ → ۳)
    expect(h.variants.get(1)!.stock).toBe(3);
  });

  it('caches only the SKU → Rahkaran product mapping, never the stock itself', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن')]);
    h.setStock('SKU-1', 0, 5);

    await h.service.assertCanAddToCart({
      variantId: 1,
      requestedTotal: 1,
      inCart: 0,
    });
    h.setStock('SKU-1', 0, 0);
    const error = await catchError(
      h.service.assertCanAddToCart({
        variantId: 1,
        requestedTotal: 1,
        inCart: 0,
      }),
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(h.rahkaran.getRetailProductByBarcode).toHaveBeenCalledTimes(1);
    expect(h.rahkaran.getRemainingQuantityInfo).toHaveBeenCalledTimes(2);
  });

  it('passes the short per-request timeout to the existing Rahkaran client', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن')]);
    h.setStock('SKU-1', 0, 5);

    await h.service.assertCanAddToCart({
      variantId: 1,
      requestedTotal: 1,
      inCart: 0,
    });

    expect(h.rahkaran.getRetailProductByBarcode).toHaveBeenCalledWith(
      'SKU-1',
      1,
      10,
      expect.objectContaining({ stage: 'stock_add_to_cart' }),
      { timeoutMs: 500 },
    );
    expect(h.rahkaran.getRemainingQuantityInfo).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Object),
      { timeoutMs: 500 },
    );
  });
});

// ------------------------------------------------------------------
// Stage 2: checkout / before payment
// ------------------------------------------------------------------

describe('RahkaranStockService — checkout', () => {
  it('stock changed between add-to-cart and checkout: checkout is blocked with the new available quantity', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'شلوار', 'مشکی', '32')]);

    h.setStock('SKU-1', 2, 1); // هنگام افزودن: ۳
    await h.service.assertCanAddToCart({
      variantId: 1,
      requestedTotal: 2,
      inCart: 0,
    });
    expect(h.variants.get(1)!.stock).toBe(3);

    h.setStock('SKU-1', 0, 1); // در فروشگاه فیزیکی فروخته شد: ۱
    const error = await catchError(
      h.service.assertCheckoutStock([{ variantId: 1, quantity: 2 }], {
        stage: 'checkout',
        excludeUserId: 7,
      }),
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual(
      expect.objectContaining({
        code: STOCK_ERROR_CODES.INSUFFICIENT,
        items: [
          {
            variantId: 1,
            productId: 10,
            productTitle: 'شلوار',
            variantLabel: 'مشکی / 32',
            requested: 2,
            available: 1,
          },
        ],
      }),
    );
    expect(h.variants.get(1)!.stock).toBe(1);
  });

  it('multiple variants: every short line is reported at once and every variant is re-synced', async () => {
    const h = makeHarness([
      variant(1, 'SKU-1', 'شلوار', 'مشکی', '32', 4),
      variant(2, 'SKU-2', 'کت', 'سرمه‌ای', 'M', 4),
      variant(3, 'SKU-3', 'کمربند', 'قهوه‌ای', 'F', 4),
    ]);
    h.setStock('SKU-1', 1, 0); // کم
    h.setStock('SKU-2', 3, 3); // کافی
    h.setStock('SKU-3', 0, 0); // ناموجود

    const error = await catchError(
      h.service.assertCheckoutStock(
        [
          { variantId: 2, quantity: 2 },
          { variantId: 1, quantity: 2 },
          { variantId: 3, quantity: 1 },
        ],
        { stage: 'checkout', excludeUserId: 7 },
      ),
    );

    const body = error.getResponse();
    expect(
      body.items.map((item: any) => [item.variantId, item.available]),
    ).toEqual([
      [1, 1],
      [3, 0],
    ]);
    expect(body.message).toContain(
      '«شلوار – مشکی / 32»: درخواستی ۲ عدد، موجود ۱ عدد',
    );
    expect(body.message).toContain('«کمربند – قهوه‌ای / F»: ناموجود');
    expect(body.message).not.toContain('کت');
    expect(h.updates.map(update => [update.id, update.stock])).toEqual([
      [1, 1],
      [2, 6],
      [3, 0],
    ]);
  });

  it('all sufficient: resolves and reports every line', async () => {
    const h = makeHarness([
      variant(1, 'SKU-1', 'شلوار'),
      variant(2, 'SKU-2', 'کت'),
    ]);
    h.setStock('SKU-1', 5, 0);
    h.setStock('SKU-2', 0, 2);

    const result = await h.service.assertCheckoutStock(
      [
        { variantId: 1, quantity: 5 },
        { variantId: 2, quantity: 2 },
      ],
      { stage: 'payment_start', excludeUserId: 7, orderId: 55 },
    );

    expect(result.ok).toBe(true);
    expect(result.verifiedWithRahkaran).toBe(true);
    expect(h.pendingCalls).toEqual([{ ids: [1, 2], excludeUserId: 7 }]);
  });

  it('payment-start message tells the customer to fix the cart and re-order', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'شلوار', 'مشکی', '32')]);
    h.setStock('SKU-1', 0, 0);

    const error = await catchError(
      h.service.assertCheckoutStock([{ variantId: 1, quantity: 1 }], {
        stage: 'payment_start',
      }),
    );

    expect(error.getResponse().message).toMatch(
      /^موجودی برخی کالاهای این سفارش تغییر کرده و امکان پرداخت آن نیست/,
    );
  });
});

// ------------------------------------------------------------------
// Rahkaran failures → fail closed (503), nothing written
// ------------------------------------------------------------------

describe('RahkaranStockService — Rahkaran unavailable or unreliable', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  const expectUnavailable = async (
    h: Harness,
    stage: 'add_to_cart' | 'checkout',
    expectedReason: string,
  ) => {
    const error = await catchError(
      stage === 'add_to_cart'
        ? h.service.assertCanAddToCart({
            variantId: 1,
            requestedTotal: 1,
            inCart: 0,
          })
        : h.service.assertCheckoutStock([{ variantId: 1, quantity: 1 }], {
            stage,
            excludeUserId: 7,
          }),
    );

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual(
      expect.objectContaining({ code: STOCK_ERROR_CODES.UNAVAILABLE }),
    );
    // موجودی سایت با دادهٔ نامطمئن تغییر نمی‌کند
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);

    const logged = errorSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(logged).toContain('stock.check.unavailable');
    expect(logged).toContain(`"reason":"${expectedReason}"`);
    return { error, logged };
  };

  it('network/HTTP error from GetRemainingQuantityInfo', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن', 'آبی', 'L', 4)]);
    h.setStock('SKU-1', 1, 1);
    h.rahkaran.getRemainingQuantityInfo.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:443'),
    );

    const { error } = await expectUnavailable(
      h,
      'add_to_cart',
      'rahkaran_error',
    );
    expect(error.getResponse().message).toBe(
      'در حال حاضر امکان بررسی موجودی از انبار وجود ندارد. کالا به سبد خرید اضافه نشد؛ لطفاً چند لحظه دیگر دوباره تلاش کنید.',
    );
    expect(h.variants.get(1)!.stock).toBe(4);
  });

  it('Rahkaran hangs: the overall deadline stops the request', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن')]);
    h.setStock('SKU-1', 1, 1);
    h.rahkaran.getRemainingQuantityInfo.mockReturnValue(new Promise(() => {}));

    const startedAt = Date.now();
    const { error } = await expectUnavailable(h, 'checkout', 'timeout');
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(error.getResponse().message).toContain('سفارش ثبت نشد');
  });

  it('empty stock answer is not treated as "zero stock"', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن', 'آبی', 'L', 4)]);
    h.setStock('SKU-1', 1, 1);
    h.rahkaran.getRemainingQuantityInfo.mockResolvedValue([]);

    await expectUnavailable(h, 'add_to_cart', 'empty_stock_info');
  });

  it('non-numeric remaining quantity', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن')]);
    h.setStock('SKU-1', 'NaN-ish', 1);

    await expectUnavailable(h, 'add_to_cart', 'invalid_stock_info');
  });

  it('SKU not found in Rahkaran', async () => {
    const h = makeHarness([variant(1, 'UNKNOWN', 'پیراهن')]);

    await expectUnavailable(h, 'checkout', 'product_not_found');
  });

  it('variant without SKU cannot be matched and is not sold blind', async () => {
    const h = makeHarness([variant(1, null, 'پیراهن', 'آبی', 'L', 50)]);

    await expectUnavailable(h, 'checkout', 'missing_sku');
    expect(h.rahkaran.getRetailProductByBarcode).not.toHaveBeenCalled();
  });

  it('logs identifiers only — no Rahkaran credentials or customer data', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن')]);
    h.setStock('SKU-1', 1, 1);
    h.rahkaran.getRemainingQuantityInfo.mockRejectedValue(
      Object.assign(new Error('Rahkaran HTTP 500'), {
        config: { headers: { Cookie: 'SESSION=secret-cookie' } },
      }),
    );

    const { logged } = await expectUnavailable(
      h,
      'add_to_cart',
      'rahkaran_error',
    );
    expect(logged).not.toContain('secret-cookie');
    expect(logged).toContain('"variantIds":[1]');
  });
});

// ------------------------------------------------------------------
// Concurrency / no double deduction
// ------------------------------------------------------------------

describe('RahkaranStockService — concurrent purchases and double deduction', () => {
  it('paid orders not yet invoiced in Rahkaran are subtracted from site stock (no units are "resurrected")', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن', 'آبی', 'L', 1)]);
    // راهکاران هنوز ۳ می‌بیند؛ ۲ عدد در سایت پرداخت شده ولی فاکتورش ثبت نشده
    h.setStock('SKU-1', 3, 0);
    h.pending.set(1, { paidNotInvoiced: 2, softReserved: 0 });

    const result = await h.service.assertCanAddToCart({
      variantId: 1,
      requestedTotal: 1,
      inCart: 0,
    });

    expect(result).toEqual(
      expect.objectContaining({ siteStock: 1, available: 1, sufficient: true }),
    );
    // site stock stays 1 (no update needed) — not overwritten with Rahkaran's 3
    expect(h.updates).toEqual([
      { id: 1, stock: 1, stockRetail: 0, stockHadishMall: 3 },
    ]);
  });

  it("another customer's in-progress order soft-reserves the last unit (but is not written into stock)", async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن', 'آبی', 'L', 1)]);
    h.setStock('SKU-1', 0, 1);
    h.pending.set(1, { paidNotInvoiced: 0, softReserved: 1 });

    const error = await catchError(
      h.service.assertCheckoutStock([{ variantId: 1, quantity: 1 }], {
        stage: 'checkout',
        excludeUserId: 8,
      }),
    );

    expect(error.getResponse().items[0]).toEqual(
      expect.objectContaining({ requested: 1, available: 0 }),
    );
    // ستون stock همان ۱ می‌ماند؛ کسر واقعی هنگام پرداخت سفارش دیگر انجام می‌شود
    expect(h.variants.get(1)!.stock).toBe(1);
    expect(h.pendingCalls[0].excludeUserId).toBe(8);
  });

  it('two customers race for the last unit: only the first checkout passes', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن', 'آبی', 'L', 1)]);
    h.setStock('SKU-1', 1, 0);

    // «دیتابیس» سفارش‌های در انتظار؛ هر checkout موفق یک سفارش PENDING می‌سازد
    const pendingOrders: Array<{
      userId: number;
      variantId: number;
      qty: number;
    }> = [];
    jest
      .spyOn(h.service as any, 'loadPendingDeductions')
      .mockImplementation((...args: unknown[]) => {
        const [, ids, excludeUserId] = args as [unknown, number[], number?];
        const map = new Map();
        for (const id of ids) {
          const softReserved = pendingOrders
            .filter(o => o.variantId === id && o.userId !== excludeUserId)
            .reduce((sum, o) => sum + o.qty, 0);
          map.set(id, { paidNotInvoiced: 0, softReserved });
        }
        return Promise.resolve(map);
      });

    const checkout = async (userId: number) => {
      await h.service.assertCheckoutStock([{ variantId: 1, quantity: 1 }], {
        stage: 'checkout',
        excludeUserId: userId,
      });
      pendingOrders.push({ userId, variantId: 1, qty: 1 });
    };

    await expect(checkout(1)).resolves.toBeUndefined();
    await expect(checkout(2)).rejects.toBeInstanceOf(ConflictException);
    // خود مشتری اول (مثلاً پرداخت دوباره) با سفارش خودش مسدود نمی‌شود
    await expect(
      h.service.assertCheckoutStock([{ variantId: 1, quantity: 1 }], {
        stage: 'payment_start',
        excludeUserId: 1,
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it('variant rows are locked in id order inside one transaction before the pending query', async () => {
    const h = makeHarness([variant(2, 'B', 'کت'), variant(1, 'A', 'شلوار')]);
    h.setStock('A', 1, 0);
    h.setStock('B', 1, 0);

    await h.service.assertCheckoutStock(
      [
        { variantId: 2, quantity: 1 },
        { variantId: 1, quantity: 1 },
      ],
      { stage: 'checkout' },
    );

    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.pendingCalls[0].ids).toEqual([1, 2]);
  });
});

// ------------------------------------------------------------------
// Pending-deduction SQL (real method, recording query builder)
// ------------------------------------------------------------------

describe('RahkaranStockService.loadPendingDeductions', () => {
  function recordingManager(results: Array<Array<Record<string, unknown>>>) {
    const queries: Array<Array<[string, ...unknown[]]>> = [];
    const manager = {
      createQueryBuilder: () => {
        const calls: Array<[string, ...unknown[]]> = [];
        queries.push(calls);
        const qb: any = new Proxy(
          {},
          {
            get: (_target, prop: string) => {
              if (prop === 'getRawMany') {
                return () => Promise.resolve(results.shift() ?? []);
              }
              return (...args: unknown[]) => {
                calls.push([prop, ...args]);
                return qb;
              };
            },
          },
        );
        return qb;
      },
    };
    return { manager, queries };
  }

  it('counts paid-not-invoiced and other customers’ recent pending orders', async () => {
    const service = new RahkaranStockService(
      {} as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
    );
    const { manager, queries } = recordingManager([
      [{ variantId: '1', qty: '2' }],
      [
        { variantId: '1', qty: '1' },
        { variantId: '3', qty: '4' },
      ],
    ]);

    const result = await (service as any).loadPendingDeductions(
      manager,
      [1, 3],
      42,
    );

    expect([...result]).toEqual([
      [1, { paidNotInvoiced: 2, softReserved: 1 }],
      [3, { paidNotInvoiced: 0, softReserved: 4 }],
    ]);

    const [paid, soft] = queries;
    const flat = (calls: Array<[string, ...unknown[]]>) =>
      JSON.stringify(calls);

    expect(flat(paid)).toContain('sync.orderId = o.id');
    expect(flat(paid)).toContain(
      JSON.stringify({
        paidStatuses: [
          OrderStatus.PAID,
          OrderStatus.SHIPPED,
          OrderStatus.DELIVERED,
        ],
      }),
    );
    expect(flat(paid)).toContain(
      JSON.stringify({ success: RahkaranInvoiceSyncStatus.SUCCESS }),
    );
    expect(flat(soft)).toContain(
      JSON.stringify({ pending: OrderStatus.PENDING }),
    );
    expect(flat(soft)).toContain(JSON.stringify({ excludeUserId: 42 }));
  });

  it('either deduction can be switched off by configuration', async () => {
    const service = new RahkaranStockService(
      {} as never,
      {} as never,
      {} as never,
      {
        get: (key: string) =>
          ({
            RAHKARAN_STOCK_PENDING_INVOICE_WINDOW_HOURS: '0',
            RAHKARAN_STOCK_SOFT_RESERVATION_MINUTES: '0',
          })[key],
      } as never,
    );
    const { manager, queries } = recordingManager([]);

    const result = await (service as any).loadPendingDeductions(manager, [1]);

    expect(result.size).toBe(0);
    expect(queries).toHaveLength(0);
  });
});

// ------------------------------------------------------------------
// Explicitly disabled
// ------------------------------------------------------------------

describe('RahkaranStockService — RAHKARAN_STOCK_CHECK_ENABLED=false', () => {
  it('falls back to the previous local stock check and never calls Rahkaran', async () => {
    const h = makeHarness([variant(1, 'SKU-1', 'پیراهن', 'آبی', 'L', 2)], {
      RAHKARAN_STOCK_CHECK_ENABLED: 'false',
    });

    await expect(
      h.service.assertCanAddToCart({
        variantId: 1,
        requestedTotal: 2,
        inCart: 0,
      }),
    ).resolves.toEqual(expect.objectContaining({ sufficient: true }));
    await expect(
      h.service.assertCanAddToCart({
        variantId: 1,
        requestedTotal: 3,
        inCart: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.rahkaran.getRemainingQuantityInfo).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
