import { RahkaranInvoiceSyncStatus } from './entities/rahkaran-invoice-sync.entity';
import { RahkaranInvoiceSyncService } from './rahkaran-invoice-sync.service';

function buildUpdateQueryBuilder(affected: number) {
  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected }),
  };

  return qb;
}

describe('RahkaranInvoiceSyncService', () => {
  const order = {
    id: 42,
    orderNumber: 'ORD-12345678-1234',
    finalPrice: 1_250_000,
    user: { phone: '09120000000' },
    items: [
      {
        quantity: 1,
        price: 1_250_000,
        variant: { sku: 'SKU-1' },
      },
    ],
  };

  let syncRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let rahkaranService: { syncOrderToRahkaran: jest.Mock };
  let ordersService: { findOne: jest.Mock };
  let service: RahkaranInvoiceSyncService;

  let claimQb: ReturnType<typeof buildUpdateQueryBuilder>;

  beforeEach(() => {
    claimQb = buildUpdateQueryBuilder(1);

    syncRepo = {
      findOne: jest.fn(),
      create: jest.fn(input => input),
      save: jest.fn(input =>
        Promise.resolve({
          id: 1,
          attempts: 0,
          ...input,
        }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(claimQb),
    };

    rahkaranService = {
      syncOrderToRahkaran: jest.fn(),
    };

    ordersService = {
      findOne: jest.fn().mockResolvedValue(order),
    };

    service = new RahkaranInvoiceSyncService(
      syncRepo as any,
      rahkaranService as any,
      ordersService as any,
    );
  });

  it('registers the invoice and marks the row as success', async () => {
    syncRepo.findOne.mockResolvedValue(null);
    rahkaranService.syncOrderToRahkaran.mockResolvedValue({
      id: 987,
      number: 'INV-1001',
    });

    const result = await service.syncPaidOrder(order, {
      trigger: 'payment',
      correlationId: 'corr-1',
    });

    expect(result.success).toBe(true);
    expect(result.invoiceId).toBe(987);
    expect(result.invoiceNumber).toBe('INV-1001');

    // correlationId باید با تلاش به سرویس راهکاران منتقل شود
    expect(rahkaranService.syncOrderToRahkaran).toHaveBeenCalledWith(
      order,
      expect.objectContaining({ correlationId: 'corr-1', attempt: 1 }),
    );

    // وضعیت نهایی success با شناسه‌های فاکتور
    expect(syncRepo.update).toHaveBeenLastCalledWith(
      { orderId: 42 },
      expect.objectContaining({
        status: RahkaranInvoiceSyncStatus.SUCCESS,
        invoiceId: 987,
        invoiceNumber: 'INV-1001',
        attempts: 1,
        lastCorrelationId: 'corr-1',
        lastError: null,
      }),
    );
  });

  it('never calls Rahkaran again when the invoice is already registered', async () => {
    syncRepo.findOne.mockResolvedValue({
      id: 1,
      orderId: 42,
      status: RahkaranInvoiceSyncStatus.SUCCESS,
      attempts: 1,
      invoiceId: 987,
      invoiceNumber: 'INV-1001',
    });

    const result = await service.syncPaidOrder(order, {
      trigger: 'scheduler',
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe('already_registered');
    expect(rahkaranService.syncOrderToRahkaran).not.toHaveBeenCalled();
    expect(syncRepo.update).not.toHaveBeenCalled();
  });

  it('does not run a concurrent attempt when one is already in progress', async () => {
    syncRepo.findOne.mockResolvedValue({
      id: 1,
      orderId: 42,
      status: RahkaranInvoiceSyncStatus.PROCESSING,
      attempts: 0,
    });
    // Claim اتمیک شکست می‌خورد (affected=0)
    claimQb.execute.mockResolvedValue({ affected: 0 });

    const result = await service.syncPaidOrder(order, {
      trigger: 'scheduler',
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe('already_in_progress');
    expect(rahkaranService.syncOrderToRahkaran).not.toHaveBeenCalled();
  });

  it('marks the row failed with the error and incremented attempts', async () => {
    syncRepo.findOne.mockResolvedValue({
      id: 1,
      orderId: 42,
      status: RahkaranInvoiceSyncStatus.FAILED,
      attempts: 2,
    });
    rahkaranService.syncOrderToRahkaran.mockRejectedValue(
      new Error('Rahkaran HTTP 500: upstream exploded'),
    );

    const result = await service.syncPaidOrder(order, {
      trigger: 'scheduler',
      correlationId: 'corr-retry',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rahkaran HTTP 500');
    expect(result.attempts).toBe(3);

    expect(rahkaranService.syncOrderToRahkaran).toHaveBeenCalledWith(
      order,
      expect.objectContaining({ correlationId: 'corr-retry', attempt: 3 }),
    );

    expect(syncRepo.update).toHaveBeenLastCalledWith(
      { orderId: 42 },
      expect.objectContaining({
        status: RahkaranInvoiceSyncStatus.FAILED,
        attempts: 3,
        lastCorrelationId: 'corr-retry',
        lastError: expect.stringContaining('Rahkaran HTTP 500'),
      }),
    );
  });

  it('recovers from a race when creating the tracking row (ER_DUP_ENTRY)', async () => {
    const rowAfterRace = {
      id: 9,
      orderId: 42,
      status: RahkaranInvoiceSyncStatus.PENDING,
      attempts: 0,
    };

    syncRepo.findOne
      .mockResolvedValueOnce(null) // اولی: رکوردی نیست
      .mockResolvedValueOnce(rowAfterRace); // بعد از duplicate

    syncRepo.save.mockRejectedValueOnce({ code: 'ER_DUP_ENTRY' });
    rahkaranService.syncOrderToRahkaran.mockResolvedValue({ id: 1 });

    const result = await service.syncPaidOrder(order);

    expect(result.success).toBe(true);
    expect(syncRepo.findOne).toHaveBeenCalledTimes(2);
  });

  it('keeps the payment path non-blocking when the tracking layer fails', async () => {
    syncRepo.findOne.mockRejectedValue(new Error('DB gone'));

    const result = await service.syncPaidOrder(order);

    expect(result.success).toBe(false);
    expect(result.error).toContain('DB gone');
  });

  it('retries retryable rows through the scheduler helper', async () => {
    const retryable = [
      {
        id: 1,
        orderId: 42,
        orderNumber: 'ORD-12345678-1234',
        status: RahkaranInvoiceSyncStatus.FAILED,
        attempts: 1,
        lastCorrelationId: 'old-corr',
      },
    ];

    const selectQb = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(retryable),
    };

    syncRepo.findOne.mockResolvedValue(retryable[0]);
    syncRepo.createQueryBuilder
      .mockReturnValueOnce(selectQb) // findRetryableSyncs
      .mockReturnValue(claimQb); // tryClaimSync calls

    rahkaranService.syncOrderToRahkaran.mockResolvedValue({ id: 555 });

    const summary = await service.retryFailedSyncs();

    expect(ordersService.findOne).toHaveBeenCalledWith(42);
    expect(summary).toEqual({ processed: 1, succeeded: 1, failed: 0 });

    // تلاش scheduler با correlationId جدید و تلاش دوم انجام می‌شود
    expect(rahkaranService.syncOrderToRahkaran).toHaveBeenCalledWith(
      order,
      expect.objectContaining({ attempt: 2 }),
    );
  });

  it('admin retry bypasses the auto-attempt cap but still respects success rows', async () => {
    syncRepo.findOne.mockResolvedValue({
      id: 1,
      orderId: 42,
      status: RahkaranInvoiceSyncStatus.FAILED,
      attempts: 30,
    });
    rahkaranService.syncOrderToRahkaran.mockResolvedValue({ id: 1 });

    const result = await service.retryOrderSync(42);

    expect(ordersService.findOne).toHaveBeenCalledWith(42);
    expect(rahkaranService.syncOrderToRahkaran).toHaveBeenCalledWith(
      order,
      expect.objectContaining({ attempt: 31 }),
    );
    expect(result.success).toBe(true);
  });
});
