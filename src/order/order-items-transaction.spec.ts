import { ShippingMethod } from './dto/create-order.dto';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item';
import { OrdersService } from './order.service';

describe('order item persistence boundary', () => {
  function setup(persistedCount: number) {
    const userRepo = { findOne: jest.fn().mockResolvedValue({ id: 1 }) };
    const addressRepo = { findOne: jest.fn().mockResolvedValue({ id: 2 }) };
    const cartRepo = {
      findOne: jest.fn().mockResolvedValue({
        items: [
          {
            quantity: 2,
            variant: {
              id: 3,
              price: 100,
              product: { id: 4, categories: [] },
            },
          },
        ],
      }),
    };
    const orderRepo = { create: jest.fn(value => value) };
    const discountService = {
      priceCartLines: jest
        .fn()
        .mockResolvedValue([
          { originalPrice: 100, unitPrice: 90, saleDiscountPerUnit: 10 },
        ]),
    };
    const manager = {
      save: jest.fn((_entity, order) => Promise.resolve({ ...order, id: 99 })),
      count: jest.fn().mockResolvedValue(persistedCount),
    };
    const commit = jest.fn(),
      rollback = jest.fn();
    const dataSource = {
      transaction: async (
        callback: (m: typeof manager) => Promise<unknown>,
      ) => {
        try {
          const result = await callback(manager);
          commit();
          return result;
        } catch (error) {
          rollback();
          throw error;
        }
      },
    };
    const service = new OrdersService(
      orderRepo as never,
      userRepo as never,
      addressRepo as never,
      cartRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      discountService as never,
      {} as never,
      {} as never,
      dataSource as never,
      {} as never,
    );
    return { service, manager, commit, rollback, addressRepo };
  }
  const dto = { addressId: 2, shippingMethod: ShippingMethod.POST };
  it('commits with the saved items attached and verifies the order relation', async () => {
    const { service, manager, commit, rollback } = setup(1);
    const order = await service.createOrder(1, dto);
    expect(manager.save).toHaveBeenCalledWith(
      Order,
      expect.objectContaining({
        items: [expect.objectContaining({ quantity: 2, totalPrice: 180 })],
      }),
    );
    expect(manager.count).toHaveBeenCalledWith(OrderItem, {
      where: { order: { id: 99 } },
    });
    expect(order.id).toBe(99);
    expect(commit).toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });
  it('creates a pickup order without an address or shipping charge', async () => {
    const { service, manager, addressRepo } = setup(1);
    const order = await service.createOrder(1, {
      shippingMethod: ShippingMethod.PICKUP,
    });
    expect(addressRepo.findOne).not.toHaveBeenCalled();
    expect(manager.save).toHaveBeenCalledWith(
      Order,
      expect.objectContaining({
        addressId: null,
        address: null,
        shippingMethod: ShippingMethod.PICKUP,
        shippingCost: 0,
        finalPrice: 180,
      }),
    );
    expect(order.shippingMethod).toBe(ShippingMethod.PICKUP);
  });
  it('requires an owned address for delivery and validates any address supplied for pickup', async () => {
    const { service, addressRepo } = setup(1);
    await expect(
      service.createOrder(1, { shippingMethod: ShippingMethod.POST }),
    ).rejects.toThrow();
    addressRepo.findOne.mockResolvedValueOnce(null);
    await expect(
      service.createOrder(1, {
        shippingMethod: ShippingMethod.PICKUP,
        addressId: 42,
      }),
    ).rejects.toThrow();
    expect(addressRepo.findOne).toHaveBeenCalledWith({
      where: { id: 42, user: { id: 1 } },
    });
  });
  it('fails the transaction when persisted items do not match the cart', async () => {
    const { service, commit, rollback } = setup(0);
    await expect(service.createOrder(1, dto)).rejects.toThrow(
      'Order items were not persisted',
    );
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalled();
  });
});
