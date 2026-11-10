import { describeDigipayPurchase } from './digipay-instrument.util';

describe('describeDigipayPurchase', () => {
  it('ابزار کیف پول دیجی‌پی را می‌شناسد', () => {
    expect(describeDigipayPurchase({ digipayPaymentGateway: 3 })).toMatchObject(
      { label: 'کیف پول دیجی‌پی', installments: null },
    );
  });

  it('اعتبار/CPG را با تأمین‌کننده تشخیص می‌دهد', () => {
    expect(
      describeDigipayPurchase({
        digipayPaymentGateway: 4,
        repaymentOption: 1,
        creditProvider: 'PARSIAN_BANK',
      }),
    ).toEqual({
      label: 'اعتبار دیجی‌پی (قسطی)',
      installments: 4,
      creditProvider: 'PARSIAN_BANK',
    });
  });

  it('BNPL یک‌جا پرداخت‌شده را یک قسط نشان می‌دهد', () => {
    expect(
      describeDigipayPurchase({
        digipayPaymentGateway: 10,
        repaymentOption: 0,
      }),
    ).toMatchObject({ label: 'خرید اعتباری دیجی‌پی (BNPL)', installments: 1 });
  });

  it('خرید اینترنتی (IPG) برچسب اینترنتی می‌گیرد', () => {
    expect(describeDigipayPurchase({ digipayPurchaseType: 0 })).toMatchObject({
      label: 'درگاه اینترنتی دیجی‌پی',
    });
  });

  it('پرداخت سایر درگاه‌ها (همهٔ ستون‌ها NULL) برچسب دیجی‌پی نمی‌گیرد', () => {
    expect(
      describeDigipayPurchase({
        digipayPaymentGateway: null,
        digipayPurchaseType: null,
        repaymentOption: null,
        creditProvider: null,
      }),
    ).toBeNull();
  });

  it('اینکه یکی از فیلدها null باشد باعث حدس‌زدن نمی‌شود', () => {
    expect(
      describeDigipayPurchase({
        digipayPaymentGateway: null,
        digipayPurchaseType: 13,
        repaymentOption: null,
      }),
    ).toEqual({
      label: 'خرید اعتباری دیجی‌پی (BNPL)',
      installments: null,
      creditProvider: null,
    });
  });
});
