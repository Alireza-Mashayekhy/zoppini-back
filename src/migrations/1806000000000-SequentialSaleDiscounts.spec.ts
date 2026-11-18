import { Discount } from 'src/discounts/entities/discount.entity';
import { getMetadataArgsStorage, QueryRunner } from 'typeorm';

import { SequentialSaleDiscounts1806000000000 } from './1806000000000-SequentialSaleDiscounts';

describe('SequentialSaleDiscounts migration', () => {
  function runner(query: jest.Mock) {
    return { query } as unknown as QueryRunner;
  }

  it('سه ستون متوالی را با پیش‌فرض‌های سازگار اضافه می‌کند', async () => {
    const query = jest
      .fn()
      // جدول discounts وجود دارد
      .mockResolvedValueOnce([{ COUNT: 1 }])
      // هیچ‌کدام از ستون‌ها وجود ندارند
      .mockResolvedValue([{ COUNT: 0 }]);

    await new SequentialSaleDiscounts1806000000000().up(runner(query));

    const statements = query.mock.calls.map(call => String(call[0]));

    expect(
      statements.some(
        statement =>
          statement.includes('ADD COLUMN `stackable`') &&
          statement.includes('DEFAULT 0'),
      ),
    ).toBe(true);

    expect(
      statements.some(
        statement =>
          statement.includes('ADD COLUMN `stackPriority`') &&
          statement.includes('DEFAULT 0'),
      ),
    ).toBe(true);

    expect(
      statements.some(
        statement =>
          statement.includes('ADD COLUMN `appliesToAllProducts`') &&
          statement.includes('DEFAULT 0'),
      ),
    ).toBe(true);
  });

  it('idempotent است و ستون‌های موجود را دوباره اضافه نمی‌کند', async () => {
    const query = jest
      .fn()
      // جدول و سه ستون از قبل وجود دارند
      .mockResolvedValue([{ COUNT: 1 }]);

    await new SequentialSaleDiscounts1806000000000().up(runner(query));

    expect(
      query.mock.calls.some(call => String(call[0]).includes('ADD COLUMN')),
    ).toBe(false);
  });

  it('در نصب تازه که جدول discounts وجود ندارد هیچ کاری نمی‌کند', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ COUNT: 0 }]);

    await new SequentialSaleDiscounts1806000000000().up(runner(query));

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('down ستون‌ها را حذف می‌کند (قابل بازگشت)', async () => {
    const query = jest.fn().mockResolvedValue([{ COUNT: 1 }]);

    await new SequentialSaleDiscounts1806000000000().down(runner(query));

    const drops = query.mock.calls
      .map(call => String(call[0]))
      .filter(statement => statement.includes('DROP COLUMN'));

    expect(drops).toHaveLength(3);
    expect(drops.join(' ')).toContain('`stackable`');
    expect(drops.join(' ')).toContain('`stackPriority`');
    expect(drops.join(' ')).toContain('`appliesToAllProducts`');
  });

  it('نام و پیش‌فرض ستون‌ها با entity هم‌خوان است (محیط تولید بدون synchronize)', () => {
    const columns = getMetadataArgsStorage().columns.filter(
      column => column.target === Discount,
    );

    const byProperty = (property: string) =>
      columns.find(column => column.propertyName === property);

    expect(
      byProperty('stackable')?.options.name ??
        byProperty('stackable')?.propertyName,
    ).toBe('stackable');
    expect(byProperty('stackable')?.options.default).toBe(false);

    expect(
      byProperty('stackPriority')?.options.name ??
        byProperty('stackPriority')?.propertyName,
    ).toBe('stackPriority');
    expect(byProperty('stackPriority')?.options.default).toBe(0);
    expect(byProperty('stackPriority')?.options.type).toBe('int');

    expect(
      byProperty('appliesToAllProducts')?.options.name ??
        byProperty('appliesToAllProducts')?.propertyName,
    ).toBe('appliesToAllProducts');
    expect(byProperty('appliesToAllProducts')?.options.default).toBe(false);
  });
});
