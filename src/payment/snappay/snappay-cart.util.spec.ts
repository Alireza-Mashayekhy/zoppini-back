import {
  buildSnappPayCart,
  buildSnappPayUpdateCart,
  generateSnappPayTransactionId,
  tomanToIrr,
} from './snappay-cart.util';

describe('SnappPay cart builder', () => {
  it('reconciles items + shipping - discount - wallet with the payable amount (IRR)', () => {
    // سفارش: دو قلم ۵۰۰٬۰۰۰ و یک قلم ۳۰۰٬۰۰۰ تومان (قبل از تخفیف)
    // totalPrice=1,300,000  shipping=170,000  discount=200,000
    // finalPrice=1,270,000  wallet=70,000  →  payable=1,200,000 تومان
    const built = buildSnappPayCart({
      orderId: 42,
      lines: [
        {
          id: 1,
          name: 'مانتو',
          category: 'پوشاک زنانه',
          unitPriceToman: 500_000,
          quantity: 2,
        },
        {
          id: 2,
          name: 'شال',
          category: 'پوشاک زنانه',
          unitPriceToman: 300_000,
          quantity: 1,
        },
      ],
      shippingToman: 170_000,
      discountToman: 200_000,
      externalToman: 70_000,
      expectedPayableToman: 1_200_000,
      commissionType: 100,
    });

    expect(built.amount).toBe(12_000_000);
    expect(built.itemsTotalAmount).toBe(13_000_000);
    expect(built.shippingAmount).toBe(1_700_000);
    expect(built.discountAmount).toBe(2_000_000);
    expect(built.externalSourceAmount).toBe(700_000);
    expect(built.totalAmount).toBe(14_700_000);
    expect(built.cartList).toEqual([
      {
        cartId: 42,
        cartItems: [
          {
            id: 1,
            name: 'مانتو',
            category: 'پوشاک زنانه',
            amount: 5_000_000,
            count: 2,
            commissionType: 100,
          },
          {
            id: 2,
            name: 'شال',
            category: 'پوشاک زنانه',
            amount: 3_000_000,
            count: 1,
            commissionType: 100,
          },
        ],
        isShipmentIncluded: false,
        isTaxIncluded: true,
        shippingAmount: 1_700_000,
        taxAmount: 0,
        totalAmount: 14_700_000,
      },
    ]);
  });

  it('works without discount, wallet and shipping', () => {
    const built = buildSnappPayCart({
      orderId: 7,
      lines: [
        {
          id: 9,
          name: 'کفش',
          category: 'کفش',
          unitPriceToman: 99_000,
          quantity: 1,
        },
      ],
      shippingToman: 0,
      discountToman: 0,
      externalToman: 0,
      expectedPayableToman: 99_000,
      commissionType: 100,
    });

    expect(built.amount).toBe(990_000);
  });

  it('rejects an order whose frozen items do not add up to its final price', () => {
    expect(() =>
      buildSnappPayCart({
        orderId: 1,
        lines: [
          {
            id: 1,
            name: 'x',
            category: 'y',
            unitPriceToman: 100_000,
            quantity: 1,
          },
        ],
        shippingToman: 0,
        discountToman: 0,
        externalToman: 0,
        // مبلغ نهایی سفارش با اقلامش نمی‌خواند (اختلاف ۵۰ هزار تومان)
        expectedPayableToman: 50_000,
        commissionType: 100,
      }),
    ).toThrow();
  });

  it('rejects empty lines and non-positive payable amounts', () => {
    expect(() =>
      buildSnappPayCart({
        orderId: 1,
        lines: [],
        shippingToman: 0,
        discountToman: 0,
        externalToman: 0,
        expectedPayableToman: 0,
        commissionType: 100,
      }),
    ).toThrow();

    expect(() =>
      buildSnappPayCart({
        orderId: 1,
        lines: [
          {
            id: 1,
            name: 'x',
            category: 'y',
            unitPriceToman: 10_000,
            quantity: 1,
          },
        ],
        shippingToman: 0,
        discountToman: 0,
        // کیف پول کل مبلغ را پوشش داده؛ چیزی برای اسنپ‌پی نمی‌ماند
        externalToman: 10_000,
        expectedPayableToman: 0,
        commissionType: 100,
      }),
    ).toThrow();
  });

  it('tolerates per-unit IRR rounding drift only within bounds', () => {
    const built = buildSnappPayCart({
      orderId: 1,
      lines: [
        {
          id: 1,
          name: 'x',
          category: 'y',
          unitPriceToman: 100.55,
          quantity: 3,
        },
      ],
      shippingToman: 0,
      discountToman: 0,
      externalToman: 0,
      expectedPayableToman: 301.65,
      commissionType: 100,
    });

    // هر واحد ۱۰۰۵/۵ ریال → ۱۰۰۶ ریال؛ جمع ۳۰۱۸ در برابر ۳۰۱۶/۵ مورد انتظار
    expect(built.amount).toBe(3018);
  });

  it('builds an update cart by reducing counts and dropping removed items', () => {
    const original = buildSnappPayCart({
      orderId: 42,
      lines: [
        {
          id: 1,
          name: 'مانتو',
          category: 'پوشاک',
          unitPriceToman: 500_000,
          quantity: 2,
        },
        {
          id: 2,
          name: 'شال',
          category: 'پوشاک',
          unitPriceToman: 300_000,
          quantity: 1,
        },
      ],
      shippingToman: 170_000,
      discountToman: 0,
      externalToman: 0,
      expectedPayableToman: 1_470_000,
      commissionType: 100,
    });

    const updated = buildSnappPayUpdateCart(
      original.cartList[0],
      new Map([
        [1, 1],
        [2, 0],
      ]),
      original.discountAmount,
      original.externalSourceAmount,
    );

    expect(updated.cartList[0].cartItems).toHaveLength(1);
    expect(updated.cartList[0].cartItems[0]).toMatchObject({ id: 1, count: 1 });
    // یک مانتو (۵۰۰ هزار تومان) + ارسال (۱۷۰ هزار تومان) = ۶۷۰ هزار تومان
    expect(updated.amount).toBe(6_700_000);
  });

  it('rejects update counts above the original count and unknown items', () => {
    const original = buildSnappPayCart({
      orderId: 42,
      lines: [
        {
          id: 1,
          name: 'x',
          category: 'y',
          unitPriceToman: 10_000,
          quantity: 1,
        },
      ],
      shippingToman: 0,
      discountToman: 0,
      externalToman: 0,
      expectedPayableToman: 10_000,
      commissionType: 100,
    });

    expect(() =>
      buildSnappPayUpdateCart(original.cartList[0], new Map([[1, 2]]), 0, 0),
    ).toThrow();
    expect(() =>
      buildSnappPayUpdateCart(original.cartList[0], new Map([[99, 1]]), 0, 0),
    ).toThrow();
    expect(() =>
      buildSnappPayUpdateCart(original.cartList[0], new Map([[1, 0]]), 0, 0),
    ).toThrow();
  });

  it('converts Toman to IRR and generates unique letter-bearing transaction ids', () => {
    expect(tomanToIrr(12_345)).toBe(123_450);
    expect(tomanToIrr(0)).toBe(0);

    const ids = new Set(
      Array.from({ length: 100 }, () => generateSnappPayTransactionId(123)),
    );

    expect(ids.size).toBe(100);

    for (const id of ids) {
      expect(id.length).toBeGreaterThanOrEqual(10);
      expect(id).toMatch(/[A-Z]/);
      expect(id).toMatch(/^[A-Z0-9]+$/);
    }
  });
});
