import { OrdersService } from './order.service';

/**
 * پنل ادمین باید وضعیت ثبت فاکتور راهکاران را همراه سفارش نشان دهد؛
 * قبلاً برای دیدن آن باید endpoint جداگانهٔ `/rahkaran/invoice-sync/order/:id`
 * صدا زده می‌شد و فهرست `/admin/orders` هیچ اشاره‌ای به راهکاران نداشت.
 */
describe('OrdersService — Rahkaran invoice status in the admin view', () => {
  const order = {
    id: 42,
    orderNumber: 'ORD-12345678-1234',
    status: 'paid',
    finalPrice: 1_250_000,
    walletPayment: 0,
    clubCreditPayment: 0,
    user: { id: 7, phone: '09120000000', rahkaranId: 77 },
    items: [],
  };

  function setup(syncMapOrError: Map<number, any> | Error) {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[order], 1]),
    };

    const orderRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn().mockResolvedValue(order),
    };

    const paymentRepo = { find: jest.fn().mockResolvedValue([]) };

    const rahkaranInvoiceSyncService = {
      getSyncStatusesForOrders: jest.fn(() =>
        syncMapOrError instanceof Error
          ? Promise.reject(syncMapOrError)
          : Promise.resolve(syncMapOrError),
      ),
    };

    const service = new OrdersService(
      orderRepo as never,
      {} as never, // userRepo
      {} as never, // addressRepo
      {} as never, // cartRepo
      {} as never, // discountRepo
      {} as never, // discountUsageRepo
      paymentRepo as never, // paymentRepo
      {} as never, // rahkaranService
      {} as never, // clubService
      {} as never, // discountService
      {} as never, // smsService
      {} as never, // walletService
      {} as never, // dataSource
      {} as never, // analyticsService
      undefined, // botEventsService
      undefined, // promotionsService
      undefined, // firstPurchaseGiftService
      rahkaranInvoiceSyncService as never,
    );

    (service as any).logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    return { service, qb, orderRepo, paymentRepo, rahkaranInvoiceSyncService };
  }

  it('exposes the sync status of every order in the admin list', async () => {
    const { service, rahkaranInvoiceSyncService } = setup(
      new Map([
        [
          42,
          {
            orderId: 42,
            status: 'failed',
            attempts: 3,
            invoiceId: null,
            invoiceNumber: null,
            lastError: 'RahkaranUnknownOutcomeError: timeout',
            lastAttemptAt: new Date('2026-01-01T10:00:00Z'),
            succeededAt: null,
            lastCorrelationId: 'rah-inv-1',
            reconcileRequiredAt: new Date('2026-01-01T10:00:00Z'),
            reconcileReason: 'timeout',
          },
        ],
      ]),
    );

    const result = await service.findAllForAdmin({ page: 1, limit: 10 });

    expect(
      rahkaranInvoiceSyncService.getSyncStatusesForOrders,
    ).toHaveBeenCalledWith([42]);
    expect(result.data[0].rahkaranInvoice).toMatchObject({
      status: 'failed',
      attempts: 3,
      lastError: 'RahkaranUnknownOutcomeError: timeout',
      lastCorrelationId: 'rah-inv-1',
      needsReconciliation: true,
      reconcileReason: 'timeout',
    });
  });

  it('returns null for orders that were never tracked', async () => {
    const { service } = setup(new Map());

    const result = await service.findAllForAdmin({ page: 1, limit: 10 });

    expect(result.data[0]).toHaveProperty('rahkaranInvoice', null);
  });

  it('keeps the admin list working when the Rahkaran status query fails', async () => {
    const { service } = setup(new Error('rahkaran table missing'));

    const result = await service.findAllForAdmin({ page: 1, limit: 10 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].rahkaranInvoice).toBeNull();
    expect(result.pagination.total).toBe(1);
  });

  it('includes the sync status in the single-order admin view', async () => {
    const { service } = setup(
      new Map([
        [
          42,
          {
            orderId: 42,
            status: 'success',
            attempts: 1,
            invoiceId: 987,
            invoiceNumber: 'INV-1001',
            lastError: null,
            lastAttemptAt: new Date('2026-01-01T10:00:00Z'),
            succeededAt: new Date('2026-01-01T10:00:05Z'),
            lastCorrelationId: 'rah-inv-2',
            reconcileRequiredAt: null,
            reconcileReason: null,
          },
        ],
      ]),
    );

    const result = await service.findOneForAdmin(42);

    expect(result.rahkaranInvoice).toMatchObject({
      status: 'success',
      invoiceId: 987,
      invoiceNumber: 'INV-1001',
      needsReconciliation: false,
    });
  });
});
