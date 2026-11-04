import { QueryRunner } from 'typeorm';
import { OrderUpdatedAtPrecision1800000000000 } from './1800000000000-OrderUpdatedAtPrecision';

describe('order update timestamp migration', () => {
  it('upgrades precision and overrides second-precision ORM updates', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const q = { hasTable: jest.fn().mockResolvedValue(true), query } as unknown as QueryRunner;
    await new OrderUpdatedAtPrecision1800000000000().up(q);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('datetime(6)'));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SET NEW.`updated_at` = CURRENT_TIMESTAMP(6)'));
  });

  it('allows synchronize to create a fresh table first', async () => {
    const query = jest.fn();
    const q = { hasTable: jest.fn().mockResolvedValue(false), query } as unknown as QueryRunner;
    await new OrderUpdatedAtPrecision1800000000000().up(q);
    expect(query).not.toHaveBeenCalled();
  });
});
