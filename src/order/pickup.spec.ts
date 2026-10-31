import { ValidationPipe } from '@nestjs/common';
import { AddHediehMallPickup1797000000000 } from 'src/migrations/1797000000000-AddHediehMallPickup';
import { QueryRunner, Table, TableColumn } from 'typeorm';

import { CreateOrderDto, ShippingMethod } from './dto/create-order.dto';

describe('Hedieh Mall pickup', () => {
  it('accepts pickup without address and requires a valid address for delivery', async () => {
    const pipe = new ValidationPipe({ transform: true });
    const check = (value: object) =>
      pipe.transform(value, { type: 'body', metatype: CreateOrderDto });
    await expect(
      check({ shippingMethod: ShippingMethod.PICKUP }),
    ).resolves.toBeInstanceOf(CreateOrderDto);
    await expect(
      check({ shippingMethod: ShippingMethod.POST }),
    ).rejects.toThrow();
    await expect(
      check({ shippingMethod: ShippingMethod.POST, addressId: 1 }),
    ).resolves.toBeInstanceOf(CreateOrderDto);
    await expect(
      check({ shippingMethod: ShippingMethod.PICKUP, addressId: null }),
    ).rejects.toThrow();
    await expect(check({ shippingMethod: 'unknown' })).rejects.toThrow();
  });
  it('adds to the existing enum while preserving other values and refuses unsafe rollback', async () => {
    const column = new TableColumn({
      name: 'shippingMethod',
      type: 'enum',
      isNullable: true,
      enum: ['post', 'courier', 'tibax', 'legacy'],
    });
    const table = new Table({ name: 'order', columns: [column] });
    const fake = {
      getTable: jest.fn().mockResolvedValue(table),
      changeColumn: jest.fn(),
      query: jest.fn(),
    };
    const q = fake as unknown as QueryRunner;
    const migration = new AddHediehMallPickup1797000000000();
    await migration.up(q);
    expect(fake.changeColumn).toHaveBeenCalledWith(
      'order',
      expect.any(TableColumn),
      expect.objectContaining({
        enum: ['post', 'courier', 'tibax', 'legacy', 'pickup'],
        isNullable: true,
      }),
    );
    column.enum!.push('pickup');
    fake.query.mockResolvedValue([{ count: 1 }]);
    await expect(migration.down(q)).rejects.toThrow('pickup orders exist');
    expect(fake.changeColumn).toHaveBeenCalledTimes(1);
    fake.query.mockResolvedValue([{ count: 0 }]);
    await migration.down(q);
    expect(fake.changeColumn).toHaveBeenLastCalledWith(
      'order',
      expect.any(TableColumn),
      expect.objectContaining({ enum: ['post', 'courier', 'tibax', 'legacy'] }),
    );
  });
});
