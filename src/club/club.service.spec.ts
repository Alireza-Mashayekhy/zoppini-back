import { BadRequestException, NotFoundException } from '@nestjs/common';
import { of, throwError } from 'rxjs';

import { ClubService } from './club.service';

describe('ClubService Diatech API contract', () => {
  const requests: Array<{ method: string; url: string }> = [];
  let service: ClubService;
  let httpService: {
    post: jest.Mock;
    request: jest.Mock;
  };

  beforeEach(() => {
    requests.length = 0;
    httpService = {
      post: jest
        .fn()
        .mockReturnValue(
          of({ data: { access_token: 'test-access-token', expires_in: 3600 } }),
        ),
      request: jest.fn().mockImplementation(config => {
        requests.push({ method: config.method, url: config.url });

        const responses: Record<string, unknown> = {
          '/api/v1/customers/09120000000/office': {
            succeeded: true,
            payload: {
              id: 7,
              customerCode: '09120000000',
              firstName: 'Test',
              lastName: 'Customer',
              totalPoint: 45,
              wallets: [{ id: 22, availableCredit: 2500 }],
            },
          },
          '/api/v1/customers/09120000000/wallets': {
            Succeeded: true,
            Payload: [{ Id: 22, WalletId: 5, AvailableCredit: 2500 }],
          },
          '/api/v1/wallet-transactions/customer-wallet/22': {
            Succeeded: true,
            Payload: [{ Id: 91, Amount: 700 }],
          },
          '/api/v1/loyalty/09120000000/Histories': {
            Succeeded: true,
            Payload: [{ Id: 11, ProgramType: 'Purchase' }],
          },
          '/api/v1/loyalty/levels': {
            succeeded: true,
            payload: [{ id: 1, title: 'Bronze', fromPoint: 0 }],
          },
          '/api/v1/payments/customer/09120000000': {
            Succeeded: true,
            Payload: [{ Id: 3, CustomerId: 7 }],
          },
        };

        return of({ data: responses[config.url] });
      }),
    };

    const configService = {
      get: (key: string) =>
        ({
          DIATECH_CLUB_BASE_URL: 'https://club.example.test',
          DIATECH_CLUB_USERNAME: 'username',
          DIATECH_CLUB_PASSWORD: 'password',
        })[key],
    };

    service = new ClubService(httpService as any, configService as any);
  });

  it('normalizes camelCase customer payloads and calls the customer endpoint', async () => {
    const customer = await service.getCustomer('09120000000');

    expect(customer).toMatchObject({
      Id: 7,
      CustomerCode: '09120000000',
      TotalPoint: 45,
      Wallets: [{ Id: 22, AvailableCredit: 2500 }],
    });
    expect(requests).toContainEqual({
      method: 'GET',
      url: '/api/v1/customers/09120000000/office',
    });
  });

  it('uses the documented wallet, transaction, loyalty, levels and payment paths', async () => {
    await expect(
      service.getCustomerWallets('09120000000'),
    ).resolves.toMatchObject([{ Id: 22, WalletId: 5 }]);
    await expect(
      service.getCustomerWalletTransactions(22),
    ).resolves.toMatchObject([{ Id: 91, Amount: 700 }]);
    await expect(
      service.getCustomerLoyaltyHistories('09120000000'),
    ).resolves.toMatchObject([{ Id: 11, ProgramType: 'Purchase' }]);
    await expect(service.getLoyaltyLevels()).resolves.toMatchObject([
      { Id: 1, Title: 'Bronze', FromPoint: 0 },
    ]);
    await expect(
      service.getCustomerPayments('09120000000'),
    ).resolves.toMatchObject([{ Id: 3, CustomerId: 7 }]);

    expect(requests.map(({ url }) => url)).toEqual([
      '/api/v1/customers/09120000000/wallets',
      '/api/v1/wallet-transactions/customer-wallet/22',
      '/api/v1/loyalty/09120000000/Histories',
      '/api/v1/loyalty/levels',
      '/api/v1/payments/customer/09120000000',
    ]);
  });

  it('supports direct endpoint payloads and generic success/data envelopes', async () => {
    httpService.request
      .mockReturnValueOnce(of({ data: [{ id: 22, availableCredit: 500 }] }))
      .mockReturnValueOnce(
        of({ data: { success: true, data: [{ id: 23, title: 'Silver' }] } }),
      );

    await expect(service.getCustomerWallets('09120000000')).resolves.toEqual([
      { Id: 22, AvailableCredit: 500 },
    ]);
    await expect(service.getLoyaltyLevels()).resolves.toEqual([
      { Id: 23, Title: 'Silver' },
    ]);
  });

  it('unwraps doubly wrapped list payloads ({ Items }, { $values })', async () => {
    httpService.request
      .mockReturnValueOnce(
        of({ data: { Succeeded: true, Payload: { Items: [{ Id: 1 }] } } }),
      )
      .mockReturnValueOnce(
        of({ data: { Succeeded: true, Payload: { $values: [{ Id: 2 }] } } }),
      )
      .mockReturnValueOnce(
        of({ data: { Succeeded: true, Payload: { Results: [{ Id: 3 }] } } }),
      );

    await expect(service.getCustomerWallets('09120000000')).resolves.toEqual([
      { Id: 1 },
    ]);
    await expect(service.getLoyaltyLevels()).resolves.toEqual([{ Id: 2 }]);
    await expect(
      service.getCustomerLoyaltyHistories('09120000000'),
    ).resolves.toEqual([{ Id: 3 }]);
  });

  it('keeps single DTO payloads intact when they match no wrapper key', async () => {
    httpService.request.mockReturnValueOnce(
      of({
        data: {
          Succeeded: true,
          Payload: { Id: 7, CustomerCode: '09120000000', TotalPoint: 11 },
        },
      }),
    );

    await expect(service.getCustomer('09120000000')).resolves.toMatchObject({
      Id: 7,
      TotalPoint: 11,
    });
  });

  it('shares one token request across concurrent dashboard API calls', async () => {
    await Promise.all([
      service.getCustomerWallets('09120000000'),
      service.getCustomerLoyaltyHistories('09120000000'),
      service.getLoyaltyLevels(),
    ]);

    expect(httpService.post).toHaveBeenCalledTimes(1);
  });

  it('reports missing customers as 404 and preserves upstream validation failures', async () => {
    httpService.request.mockReturnValueOnce(
      throwError(() => ({ response: { status: 404 }, message: 'not found' })),
    );
    await expect(service.getCustomer('09120000000')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    httpService.request.mockReturnValueOnce(
      throwError(() => ({
        response: { status: 400, data: { message: 'invalid customer code' } },
        message: 'bad request',
      })),
    );
    await expect(service.getCustomer('bad-code')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
