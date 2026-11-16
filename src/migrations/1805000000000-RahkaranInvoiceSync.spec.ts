import { QueryRunner } from 'typeorm';

import { RahkaranInvoiceSync1805000000000 } from './1805000000000-RahkaranInvoiceSync';

describe('RahkaranInvoiceSync migration', () => {
  it('creates the tracking table with idempotency + retry indexes', async () => {
    const query = jest
      .fn()
      // بررسی INFORMATION_SCHEMA: جدول وجود ندارد
      .mockResolvedValueOnce([{ COUNT: 0 }])
      .mockResolvedValue(undefined);

    const q = { query } as unknown as QueryRunner;

    await new RahkaranInvoiceSync1805000000000().up(q);

    const ddl: string = query.mock.calls[1][0];

    expect(ddl).toContain('CREATE TABLE `rahkaran_invoice_sync`');
    expect(ddl).toContain('UNIQUE KEY `UQ_rahkaran_invoice_sync_order`');
    expect(ddl).toContain("`status` ENUM('pending','processing','success','failed')");
    expect(ddl).toContain('`last_correlation_id`');
    expect(ddl).toContain('`last_attempt_at` DATETIME(6)');
  });

  it('is idempotent when the table already exists', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ COUNT: 1 }]);

    const q = { query } as unknown as QueryRunner;

    await new RahkaranInvoiceSync1805000000000().up(q);

    // فقط کوئری بررسی وجود جدول اجرا شده، CREATE تکرار نمی‌شود
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('drops the table on down()', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ COUNT: 1 }])
      .mockResolvedValue(undefined);

    const q = { query } as unknown as QueryRunner;

    await new RahkaranInvoiceSync1805000000000().down(q);

    expect(query).toHaveBeenLastCalledWith(
      'DROP TABLE `rahkaran_invoice_sync`',
    );
  });
});
