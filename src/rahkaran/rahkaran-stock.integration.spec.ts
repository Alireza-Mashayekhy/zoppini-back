/**
 * The Rahkaran stock check wired into the real cart, order and payment-guard
 * paths. The stock service is mocked here; its own behaviour is covered in
 * rahkaran-stock.service.spec.ts.
 *
 * Goal: show that every entry point (add to cart, raise quantity, create
 * order, wallet confirm, start payment) calls the check with the right
 * quantities, and that nothing is written when it fails.
 */
import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CartsService } from 'src/cart/cart.service';
import { ShippingMethod } from 'src/order/dto/create-order.dto';
import { OrderStatus } from 'src/order/entities/order.entity';
import { OrdersService } from 'src/order/order.service';
import { PaymentStatus } from 'src/payment/entities/payment.entity';
import { PaymentGuardService } from 'src/payment/services/payment-guard.service';

import { STOCK_ERROR_CODES } from './rahkaran-stock.service';

const shortage = () =>
  new ConflictException({
    statusCode: 409,
    code: STOCK_ERROR_CODES.INSUFFICIENT,
    message: 'موجودی کافی نیست',
    items: [{ variantId: 3, requested: 3, available: 1 }],
  });

const unavailable = () =>
  new ServiceUnavailableException({
    statusCode: 503,
    code: STOCK_ERROR_CODES.UNAVAILABLE,
    message: 'در حال حاضر امکان بررسی موجودی از انبار وجود ندارد.',
  });

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

// ------------------------------------------------------------------
// Cart
// ------------------------------------------------------------------

describe('CartsService → stock check at add-to-cart', () => {
  function setup(items: Array<Record<string, unknown>>) {
    const cart = { id: 1, items };
    const stock = { assertCanAddToCart: jest.fn().mockResolvedValue({}) };
    const cartItemRepo = {
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      create: jest.fn((value: unknown) => value),
      remove: jest.fn(),
    };
    const variantRepo = {
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve({
          id: where.id,
          stock: 999, // local stock is no longer trusted
          product: { title: 'پیراهن', categories: [] },
        }),
      ),
    };

    const service = new CartsService(
      {} as never,
      cartItemRepo as never,
      variantRepo as never,
      {} as never,
      {} as never,
      stock as never,
    );
    jest.spyOn(service, 'getOrCreateCart').mockResolvedValue(cart as never);
    jest
      .spyOn(service, 'getCart')
      .mockResolvedValue({ id: 1, priced: true } as never);

    return { service, stock, cartItemRepo };
  }

  it('checks existing cart quantity (regular + gift rows) plus the new quantity', async () => {
    const { service, stock, cartItemRepo } = setup([
      { id: 10, quantity: 2, variant: { id: 3 }, promotionRewardId: null },
      { id: 11, quantity: 1, variant: { id: 3 }, promotionRewardId: 5 },
      { id: 12, quantity: 4, variant: { id: 8 }, promotionRewardId: null },
    ]);

    await service.addToCart(7, undefined, { variantId: 3, quantity: 2 });

    expect(stock.assertCanAddToCart).toHaveBeenCalledWith({
      variantId: 3,
      requestedTotal: 5,
      inCart: 3,
      stage: 'add_to_cart',
      userId: 7,
    });
    // only the regular row is merged into; the gift row stays separate
    expect(cartItemRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, quantity: 4 }),
    );
  });

  it('insufficient stock (409): nothing is added to the cart', async () => {
    const { service, stock, cartItemRepo } = setup([]);
    stock.assertCanAddToCart.mockRejectedValue(shortage());

    await expect(
      service.addToCart(7, undefined, { variantId: 3, quantity: 3 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(cartItemRepo.save).not.toHaveBeenCalled();
    expect(cartItemRepo.create).not.toHaveBeenCalled();
  });

  it('Rahkaran unavailable (503): nothing is added to the cart', async () => {
    const { service, stock, cartItemRepo } = setup([
      { id: 10, quantity: 1, variant: { id: 3 }, promotionRewardId: null },
    ]);
    stock.assertCanAddToCart.mockRejectedValue(unavailable());

    await expect(
      service.addToCart(undefined, 'guest-1', { variantId: 3, quantity: 1 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(cartItemRepo.save).not.toHaveBeenCalled();
  });

  it('raising a line quantity is checked against the total of all rows', async () => {
    const { service, stock, cartItemRepo } = setup([
      { id: 10, quantity: 1, variant: { id: 3 }, promotionRewardId: null },
      { id: 11, quantity: 1, variant: { id: 3 }, promotionRewardId: 5 },
    ]);

    await service.updateItemQuantity(7, undefined, 10, { quantity: 4 });

    expect(stock.assertCanAddToCart).toHaveBeenCalledWith({
      variantId: 3,
      requestedTotal: 5,
      inCart: 2,
      stage: 'update_cart',
      userId: 7,
    });
    expect(cartItemRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, quantity: 4 }),
    );
  });

  it('raising a quantity beyond Rahkaran stock leaves the line unchanged', async () => {
    const { service, stock, cartItemRepo } = setup([
      { id: 10, quantity: 1, variant: { id: 3 }, promotionRewardId: null },
    ]);
    stock.assertCanAddToCart.mockRejectedValue(shortage());

    await expect(
      service.updateItemQuantity(7, undefined, 10, { quantity: 3 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(cartItemRepo.save).not.toHaveBeenCalled();
  });

  it('lowering a quantity never calls Rahkaran (an outage must not stop customers fixing their cart)', async () => {
    const { service, stock, cartItemRepo } = setup([
      { id: 10, quantity: 3, variant: { id: 3 }, promotionRewardId: null },
    ]);

    await service.updateItemQuantity(7, undefined, 10, { quantity: 1 });

    expect(stock.assertCanAddToCart).not.toHaveBeenCalled();
    expect(cartItemRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, quantity: 1 }),
    );
  });
});

// ------------------------------------------------------------------
// Orders: checkout (createOrder) and wallet confirm
// ------------------------------------------------------------------

describe('OrdersService → stock check before creating / confirming an order', () => {
  function setup(
    stock: unknown = {
      assertCheckoutStock: jest.fn().mockResolvedValue(undefined),
    },
  ) {
    const cartRepo = {
      findOne: jest.fn().mockResolvedValue({
        items: [
          {
            quantity: 2,
            variant: { id: 3, product: { id: 4, categories: [] } },
          },
          {
            quantity: 1,
            variant: { id: 9, product: { id: 5, categories: [] } },
          },
        ],
      }),
    };
    const transaction = jest.fn();
    const service = new OrdersService(
      { create: jest.fn() } as never,
      { findOne: jest.fn().mockResolvedValue({ id: 1 }) } as never,
      { findOne: jest.fn().mockResolvedValue({ id: 2 }) } as never,
      cartRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { priceCartLines: jest.fn() } as never,
      {} as never,
      {} as never,
      { transaction } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      stock as never,
    );
    return { service, stock: stock as any, transaction };
  }

  const dto = { addressId: 2, shippingMethod: ShippingMethod.POST };

  it('checks every cart line with the requesting user excluded from soft reservations', async () => {
    const { service, stock } = setup();
    stock.assertCheckoutStock.mockRejectedValue(shortage());

    await expect(service.createOrder(1, dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(stock.assertCheckoutStock).toHaveBeenCalledWith(
      [
        { variantId: 3, quantity: 2 },
        { variantId: 9, quantity: 1 },
      ],
      { stage: 'checkout', excludeUserId: 1, orderId: undefined },
    );
  });

  it('insufficient stock: no order (and no transaction) is created', async () => {
    const { service, stock, transaction } = setup();
    stock.assertCheckoutStock.mockRejectedValue(shortage());

    const error: any = await service.createOrder(1, dto).catch(e => e);

    expect(error.getResponse().items).toEqual([
      { variantId: 3, requested: 3, available: 1 },
    ]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('Rahkaran unavailable: no order is created', async () => {
    const { service, stock, transaction } = setup();
    stock.assertCheckoutStock.mockRejectedValue(unavailable());

    await expect(service.createOrder(1, dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('fails closed (503) if the stock service is missing', async () => {
    const { service, transaction } = setup(null);

    const error: any = await service.createOrder(1, dto).catch(e => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse().code).toBe(STOCK_ERROR_CODES.UNAVAILABLE);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('wallet / club-credit confirm (the path that never reaches a gateway) re-checks first', async () => {
    const { service, stock } = setup();
    const order = {
      id: 55,
      status: OrderStatus.PENDING,
      finalPrice: 100,
      walletPayment: 100,
      clubCreditPayment: 0,
      items: [{ quantity: 2, variant: { id: 3 } }],
    };
    jest.spyOn(service, 'findOne').mockResolvedValue(order as never);
    const confirm = jest
      .spyOn(service, 'confirmOrderPayment')
      .mockResolvedValue(order as never);

    stock.assertCheckoutStock.mockRejectedValueOnce(shortage());
    await expect(service.confirmOrderFromWallet(55, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(confirm).not.toHaveBeenCalled();

    await service.confirmOrderFromWallet(55, 1);
    expect(stock.assertCheckoutStock).toHaveBeenLastCalledWith(
      [{ variantId: 3, quantity: 2 }],
      { stage: 'wallet_confirm', excludeUserId: 1, orderId: 55 },
    );
    expect(confirm).toHaveBeenCalledWith(55);
  });
});

// ------------------------------------------------------------------
// Payment guard: the single gate before every gateway
// ------------------------------------------------------------------

describe('PaymentGuardService → stock check before redirecting to the gateway', () => {
  const order = {
    id: 55,
    status: OrderStatus.PENDING,
    finalPrice: 500,
    walletPayment: 0,
    clubCreditPayment: 0,
    user: { id: 7, phone: '09120000000' },
    items: [
      { quantity: 1, variant: { id: 9 } },
      { quantity: 2, variant: { id: 3 } },
    ],
  } as any;

  function setup(
    openPayments: unknown[] = [],
    stockService: unknown = {
      assertCheckoutStock: jest.fn().mockResolvedValue(undefined),
    },
  ) {
    const paymentRepo = {
      find: jest.fn().mockResolvedValue(openPayments),
      save: jest.fn(),
    };
    const guard = new PaymentGuardService(
      paymentRepo as never,
      { assertPayable: jest.fn() } as never,
      undefined,
      undefined,
      stockService as never,
    );
    return { guard, paymentRepo, stock: stockService as any };
  }

  it('checks every order line, excluding the customer’s own pending order', async () => {
    const { guard, stock } = setup();

    await guard.ensureOrderPayable(order);

    expect(stock.assertCheckoutStock).toHaveBeenCalledWith(
      [
        { variantId: 9, quantity: 1 },
        { variantId: 3, quantity: 2 },
      ],
      { stage: 'payment_start', excludeUserId: 7, orderId: 55 },
    );
  });

  it('stock changed after the order was created: payment is not started and older attempts stay untouched', async () => {
    const stale = { id: 1, status: PaymentStatus.PENDING, gateway: 'mellat' };
    const { guard, stock, paymentRepo } = setup([stale]);
    stock.assertCheckoutStock.mockRejectedValue(shortage());

    await expect(guard.ensureOrderPayable(order)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(paymentRepo.save).not.toHaveBeenCalled();
  });

  it('a payment that already succeeded is still reported as such (no Rahkaran call)', async () => {
    const { guard, stock } = setup([
      { id: 1, status: PaymentStatus.SUCCESS, gateway: 'mellat' },
    ]);

    await expect(guard.ensureOrderPayable(order)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(stock.assertCheckoutStock).not.toHaveBeenCalled();
  });

  it('fails closed (503) if the stock service is missing', async () => {
    const { guard } = setup([], null);

    await expect(guard.ensureOrderPayable(order)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

// ------------------------------------------------------------------
// confirmOrderPayment: atomic, ordered stock decrement
// ------------------------------------------------------------------

describe('OrdersService.confirmOrderPayment → no oversell when two payments land together', () => {
  function setup(stockById: Record<number, number>) {
    const updates: Array<{ id: number; quantity: number }> = [];
    const order = {
      id: 55,
      orderNumber: 'ZP-55',
      status: OrderStatus.PENDING,
      walletPayment: 0,
      user: { id: 7 },
      items: [
        { quantity: 1, variant: { id: 9 } },
        { quantity: 2, variant: { id: 3 } },
      ],
    };

    const updateQb: any = {
      update: () => updateQb,
      set: () => updateQb,
      where: (_sql: string, params: { id: number; quantity: number }) => {
        updateQb.params = params;
        return updateQb;
      },
      execute: () => {
        const { id, quantity } = updateQb.params;
        updates.push({ id, quantity });
        // simulates `UPDATE ... WHERE stock >= :quantity` in the database
        if (stockById[id] >= quantity) {
          stockById[id] -= quantity;
          return Promise.resolve({ affected: 1 });
        }
        return Promise.resolve({ affected: 0 });
      },
    };

    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        findOne: jest.fn((entity: any, options: any) => {
          if (entity?.name === 'Order') return Promise.resolve(order);
          if (entity?.name === 'User') return Promise.resolve({ id: 7 });
          // the read is not locked: assume the stale value passed the check
          return Promise.resolve({
            id: options.where.id,
            stock: 100,
            product: { title: `محصول ${options.where.id}` },
          });
        }),
        createQueryBuilder: () => updateQb,
      },
    };

    const service = Object.create(OrdersService.prototype) as OrdersService;
    Object.assign(service, {
      dataSource: { createQueryRunner: () => queryRunner },
      logger: new Logger('test'),
    });

    return { service, queryRunner, updates, stockById };
  }

  it('decrements variants in id order and rolls back when the conditional UPDATE matches no row', async () => {
    // variant 3 had 2 in stock, but a parallel payment already took one
    const { service, queryRunner, updates, stockById } = setup({ 3: 1, 9: 5 });

    await expect(service.confirmOrderPayment(55)).rejects.toThrow(
      'موجودی کافی نیست برای محصول 3',
    );

    expect(updates).toEqual([{ id: 3, quantity: 2 }]);
    expect(stockById).toEqual({ 3: 1, 9: 5 });
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });
});
