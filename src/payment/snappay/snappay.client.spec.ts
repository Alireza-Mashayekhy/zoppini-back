import { SnappPayClient, SnappPayError } from './snappay.client';

const config = {
  baseUrl: 'https://snapp.example',
  clientId: 'client',
  clientSecret: 'secret',
  username: 'merchant',
  password: 'password',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const auth = () => json({ access_token: 'access-token', expires_in: 3600 });

describe('SnappPay v2.1 client', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('authenticates with the documented form and returns unmodified dynamic eligibility', async () => {
    fetchMock.mockResolvedValueOnce(auth()).mockResolvedValueOnce(
      json({
        successful: true,
        response: {
          eligible: true,
          title_message: 'عنوان',
          description: 'توضیح',
        },
      }),
    );
    const result = await new SnappPayClient(config).eligible(123450);
    expect(result).toEqual({
      eligible: true,
      title_message: 'عنوان',
      description: 'توضیح',
    });
    const [authUrl, authOptions] = fetchMock.mock.calls[0];
    expect(authUrl).toBe('https://snapp.example/api/online/v1/oauth/token');
    expect(authOptions?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`,
    });
    expect(new URLSearchParams(authOptions?.body as string).get('scope')).toBe(
      'online-merchant',
    );
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://snapp.example/api/online/offer/v1/eligible?amount=123450',
    );
    expect(options?.headers).toMatchObject({
      Authorization: 'Bearer access-token',
    });
  });

  it('shares a token across concurrent requests and sends optional method restrictions', async () => {
    fetchMock
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(
        json({ successful: true, response: { eligible: false } }),
      )
      .mockResolvedValueOnce(
        json({ successful: true, response: { eligible: false } }),
      );
    const client = new SnappPayClient(config);
    await Promise.all([
      client.eligible(1000, ['INSTALLMENT', 'FINANCING']),
      client.eligible(2000),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      'paymentMethodTypes=INSTALLMENT%2CFINANCING',
    );
  });

  it('posts verify only once on timeout and exposes an inconclusive transport error', async () => {
    fetchMock
      .mockResolvedValueOnce(auth())
      .mockRejectedValueOnce(new Error('timeout'));
    const client = new SnappPayClient(config);
    await expect(client.verify('payment-token')).rejects.toMatchObject({
      kind: 'transport',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://snapp.example/api/online/payment/v1/verify',
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      paymentToken: 'payment-token',
    });
  });

  it('does not retry a state-changing request after a 401 and refreshes on the next request', async () => {
    fetchMock
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(json({ successful: false }, 401))
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(
        json({ successful: true, response: { transactionId: 'A12345' } }),
      );
    const client = new SnappPayClient(config);
    await expect(client.settle('payment-token')).rejects.toMatchObject({
      kind: 'provider',
      httpStatus: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(client.settle('payment-token')).resolves.toEqual({
      transactionId: 'A12345',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('validates status and rejects unsafe payment URLs', async () => {
    fetchMock
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(
        json({
          successful: true,
          response: {
            transactionId: 'A12345',
            status: 'SETTLE',
            amount: 10000,
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          successful: true,
          response: {
            paymentToken: 'token',
            paymentPageUrl: 'javascript:alert(1)',
          },
        }),
      );
    const client = new SnappPayClient(config);
    await expect(client.status('x+y')).resolves.toMatchObject({
      status: 'SETTLE',
      amount: 10000,
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://snapp.example/api/online/payment/v1/status?paymentToken=x%2By',
    );
    await expect(
      client.createPayment({
        amount: 10000,
        cartList: [],
        discountAmount: 0,
        externalSourceAmount: 0,
        mobile: '09120000000',
        returnURL: 'https://shop.example/callback',
        transactionId: 'A12345',
      }),
    ).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('rejects missing credentials and non HTTPS provider URLs', () => {
    expect(
      () => new SnappPayClient({ ...config, baseUrl: 'http://snapp.example' }),
    ).toThrow(SnappPayError);
    expect(() => new SnappPayClient({ ...config, password: '' })).toThrow(
      SnappPayError,
    );
  });
});
