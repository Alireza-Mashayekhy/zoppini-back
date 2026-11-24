import { of, throwError } from 'rxjs';

import {
  isRahkaranUnknownOutcome,
  RahkaranService,
  RahkaranUnknownOutcomeError,
} from './rahkaran.service';

const BASE_URL = 'https://rahkaran.test';

function capturingLogger() {
  const lines: string[] = [];

  const capture =
    () =>
    (message: unknown, ...rest: unknown[]) => {
      lines.push(
        [message, ...rest]
          .map(part => (typeof part === 'string' ? part : JSON.stringify(part)))
          .join(' | '),
      );
    };

  return {
    lines,
    logger: {
      log: capture(),
      error: capture(),
      warn: capture(),
      debug: capture(),
      verbose: capture(),
    },
  };
}

function transportError(code = 'ETIMEDOUT') {
  const error = new Error(`connect ${code}`) as Error & {
    code?: string;
    isAxiosError?: boolean;
  };

  error.code = code;
  error.isAxiosError = true;

  return error;
}

const invoiceInput = {
  customerId: 77,
  items: [
    {
      productId: 501,
      unitId: 2,
      quantity: 1,
      fee: 6_250_000,
      price: 6_250_000,
    },
  ],
  receiptAmount: 6_250_000,
};

describe('RahkaranService — unknown outcome and idempotent loyalty', () => {
  let httpService: { request: jest.Mock };
  let usersService: { findOne: jest.Mock; update: jest.Mock };
  let service: RahkaranService;
  let logSink: ReturnType<typeof capturingLogger>;

  const user = {
    id: 9,
    fullName: 'سارا محمدی',
    phone: '09121234567',
    nationalCode: '0012345678',
    rahkaranId: null as number | null,
    loyaltyMemberSyncedAt: null as Date | null,
  };

  beforeEach(() => {
    const configService = {
      get: (key: string) =>
        ({
          RAHKARAN_BASE_URL: BASE_URL,
          RAHKARAN_USERNAME: 'zoppini-user',
          RAHKARAN_PASSWORD: 'secret-password',
          RAHKARAN_MACHINE_NAME: 'MACHINE-1',
          RAHKARAN_AUTO_LOGIN: 'false',
        })[key],
    };

    httpService = { request: jest.fn() };
    usersService = {
      findOne: jest.fn().mockResolvedValue({ ...user }),
      update: jest
        .fn()
        .mockImplementation((_id, data) => Promise.resolve(data)),
    };

    service = new RahkaranService(
      httpService as any,
      configService as any,
      usersService as any,
    );

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

    logSink = capturingLogger();
    (service as any).logger = logSink.logger;
  });

  function loggedEvents() {
    return logSink.lines
      .map(line => {
        const start = line.indexOf('{');

        if (start === -1) {
          return null;
        }

        try {
          return JSON.parse(line.slice(start));
        } catch {
          return null;
        }
      })
      .filter((event): event is Record<string, any> => !!event?.event);
  }

  describe('invoice registration with unknown outcome', () => {
    it('treats a 2xx response without a Rahkaran envelope as unknown, not rejected', async () => {
      httpService.request.mockImplementation(() =>
        of({ data: '', headers: {} }),
      );

      const promise = service.createSalesInvoice(invoiceInput);

      await expect(promise).rejects.toBeInstanceOf(RahkaranUnknownOutcomeError);
      await promise.catch(error => {
        expect(isRahkaranUnknownOutcome(error)).toBe(true);
      });

      const event = loggedEvents().find(
        e => e.event === 'rahkaran.invoice.create.outcome_unknown',
      );

      expect(event).toBeTruthy();
      expect(event?.note).toContain('invoice_may_exist_in_rahkaran');
    });

    it('treats a transport failure of SaveInvoice as unknown outcome', async () => {
      httpService.request.mockImplementation(() =>
        throwError(() => transportError('ECONNRESET')),
      );

      await expect(
        service.createSalesInvoice(invoiceInput),
      ).rejects.toBeInstanceOf(RahkaranUnknownOutcomeError);
    });

    it('keeps an explicit Rahkaran rejection retryable (not unknown)', async () => {
      httpService.request.mockImplementation(() =>
        of({
          data: {
            result: null,
            metadata: {
              isSuccessfull: false,
              errorMessage: 'موجودی کافی نیست',
            },
          },
          headers: {},
        }),
      );

      const error = await service
        .createSalesInvoice(invoiceInput)
        .catch(err => err);

      expect(isRahkaranUnknownOutcome(error)).toBe(false);
    });

    it('clears the dead session on a 401 from a POST (retryable, not unknown)', async () => {
      httpService.request.mockImplementation(() =>
        of({ status: 401, data: { message: 'unauthorized' }, headers: {} }),
      );

      const error = await service
        .createSalesInvoice(invoiceInput)
        .catch(err => err);

      expect(error?.message).toContain('Rahkaran HTTP 401');
      expect(isRahkaranUnknownOutcome(error)).toBe(false);
      // Session مرده پاک می‌شود تا درخواست بعدی دوباره login کند
      expect(service.isAuthenticated()).toBe(false);
    });

    it('does not mark a failed GET as unknown (reads have no side effect)', async () => {
      httpService.request.mockImplementation(() =>
        throwError(() => transportError('ETIMEDOUT')),
      );

      const error = await service
        .getCustomerIdByMobile('09121234567')
        .catch(err => err);

      expect(error).toBeTruthy();
      expect(isRahkaranUnknownOutcome(error)).toBe(false);
    });
  });

  describe('loyalty registration idempotency', () => {
    it('sends nothing when the user is already synced', async () => {
      usersService.findOne.mockResolvedValue({
        ...user,
        rahkaranId: 77,
        loyaltyMemberSyncedAt: new Date('2026-01-01T00:00:00Z'),
      });

      const result = await service.createLoyaltyMemberForUser(9);

      expect(result).toEqual({ customerId: 77, skipped: 'already_synced' });
      expect(httpService.request).not.toHaveBeenCalled();
      expect(usersService.update).not.toHaveBeenCalled();
    });

    it('reuses the existing customer by mobile instead of creating a duplicate', async () => {
      httpService.request.mockImplementation((config: any) => {
        if (config.url.includes('/ESales.svc/customers')) {
          return of({
            data: {
              result: [{ id: 77 }],
              metadata: { isSuccessfull: true },
            },
            headers: {},
          });
        }

        if (config.url.includes('loyaltyMember')) {
          return of({
            data: { result: { id: 5 }, metadata: { isSuccessfull: true } },
            headers: {},
          });
        }

        throw new Error(`unexpected call: ${config.url}`);
      });

      const result = await service.createLoyaltyMemberForUser(9);

      expect(result).toEqual({ customerId: 77 });

      const urls = httpService.request.mock.calls.map(call => call[0].url);

      // هیچ درخواست ساخت مشتری ارسال نشده است
      expect(
        urls.filter((url: string) =>
          url.includes('/Structure/CustomerService.svc/customer'),
        ),
      ).toHaveLength(0);

      expect(usersService.update).toHaveBeenCalledWith(9, { rahkaranId: 77 });
      expect(usersService.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ loyaltyMemberSyncedAt: expect.any(Date) }),
      );
    });

    it('creates the customer only when it does not exist', async () => {
      let customerLookups = 0;

      httpService.request.mockImplementation((config: any) => {
        if (config.url.includes('/ESales.svc/customers')) {
          customerLookups += 1;

          return of({
            data: {
              result: customerLookups === 1 ? [] : [{ id: 88 }],
              metadata: { isSuccessfull: true },
            },
            headers: {},
          });
        }

        if (config.url.includes('/Structure/CustomerService.svc/customer')) {
          return of({
            data: { metadata: { isSuccessfull: true } },
            headers: {},
          });
        }

        if (config.url.includes('loyaltyMember')) {
          return of({
            data: { metadata: { isSuccessfull: true } },
            headers: {},
          });
        }

        throw new Error(`unexpected call: ${config.url}`);
      });

      const result = await service.createLoyaltyMemberForUser(9);

      expect(result).toEqual({ customerId: 88 });
      expect(usersService.update).toHaveBeenCalledWith(9, { rahkaranId: 88 });
    });

    it('keeps the customer id when only the loyalty step fails, so the retry does not duplicate it', async () => {
      httpService.request.mockImplementation((config: any) => {
        if (config.url.includes('/ESales.svc/customers')) {
          return of({
            data: { result: [{ id: 77 }], metadata: { isSuccessfull: true } },
            headers: {},
          });
        }

        if (config.url.includes('loyaltyMember')) {
          return of({
            data: {
              result: null,
              metadata: { isSuccessfull: false, errorMessage: 'خطای راهکاران' },
            },
            headers: {},
          });
        }

        throw new Error(`unexpected call: ${config.url}`);
      });

      await expect(service.createLoyaltyMemberForUser(9)).rejects.toThrow(
        'خطای راهکاران',
      );

      expect(usersService.update).toHaveBeenCalledWith(9, { rahkaranId: 77 });
      expect(usersService.update).not.toHaveBeenCalledWith(
        9,
        expect.objectContaining({ loyaltyMemberSyncedAt: expect.any(Date) }),
      );
    });

    it('resumes from the persisted customer id without searching again', async () => {
      usersService.findOne.mockResolvedValue({
        ...user,
        rahkaranId: 77,
        loyaltyMemberSyncedAt: null,
      });

      httpService.request.mockImplementation((config: any) => {
        if (config.url.includes('loyaltyMember')) {
          return of({
            data: { metadata: { isSuccessfull: true } },
            headers: {},
          });
        }

        throw new Error(`unexpected call: ${config.url}`);
      });

      const result = await service.createLoyaltyMemberForUser(9);

      expect(result).toEqual({ customerId: 77 });
      expect(
        httpService.request.mock.calls
          .map(call => call[0].url)
          .filter((url: string) => url.includes('/ESales.svc/customers')),
      ).toHaveLength(0);
      expect(usersService.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ loyaltyMemberSyncedAt: expect.any(Date) }),
      );
    });

    it('warns (without failing) when several customers share the mobile', async () => {
      httpService.request.mockImplementation((config: any) => {
        if (config.url.includes('/ESales.svc/customers')) {
          return of({
            data: {
              result: [{ id: 77 }, { id: 91 }],
              metadata: { isSuccessfull: true },
            },
            headers: {},
          });
        }

        if (config.url.includes('loyaltyMember')) {
          return of({
            data: { metadata: { isSuccessfull: true } },
            headers: {},
          });
        }

        throw new Error(`unexpected call: ${config.url}`);
      });

      const result = await service.createLoyaltyMemberForUser(9);

      expect(result).toEqual({ customerId: 77 });

      const event = loggedEvents().find(
        e => e.event === 'rahkaran.customer.multiple_matches',
      );

      expect(event).toMatchObject({
        matches: 2,
        customerMobile: '0912****567',
        note: 'first_match_used',
      });
    });
  });
});
