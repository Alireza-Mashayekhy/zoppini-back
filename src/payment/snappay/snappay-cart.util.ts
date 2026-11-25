import { randomBytes } from 'crypto';

import { SnappPayCart } from './snappay.client';

/**
 * ساخت `cartList` اسنپ‌پی از اقلام فریز‌شدهٔ سفارش.
 *
 * همهٔ مبالغ این فایل در خروجی «ریال صحیح» هستند (واحد اسنپ‌پی IRR است) و
 * ورودی‌ها «تومان» (واحد داخلی سایت؛ مثل بقیهٔ درگاه‌ها ×۱۰ می‌شود).
 *
 * فرمول خود مستند اسنپ‌پی (بخش نحوهٔ محاسبهٔ totalAmount و amount، صفحه ۱۴):
 *   totalAmount هر سبد = Σ(count × amount هر قلم)
 *                        + هزینه ارسال (اگر داخل قیمت اقلام نباشد)
 *                        + مالیات (اگر داخل قیمت اقلام نباشد)
 *   amount سفارش       = Σ(totalAmount سبدها) − discountAmount − externalSourceAmount
 *
 * طبق الزام مستند (صفحه‌های ۱۰–۱۴ و ۲۳–۲۵) پرچم‌های `isShipmentIncluded`
 * و `isTaxIncluded` همیشه `true` ارسال می‌شوند. یعنی هزینهٔ ارسال و مالیات
 * «شاملِ» مبلغ کل گزارش‌شده هستند و نباید جای دیگر دوباره جمع زده شوند.
 * در مدل زوپینی قیمت واحدِ هر قلم شامل ارسال/مالیات نیست، پس برای اینکه
 * مبلغ ارسال دقیقاً «یک بار» و نه دو بار در totalAmount لحاظ شود، مبلغ
 * ارسال را مستقیماً به totalAmount اضافه می‌کنیم و پرچم را `true` می‌گذاریم
 * (شارژ ارسال جزء totalAmount است و جداگانه دو‌باره جمع نمی‌شود).
 *
 * نگاشت به مدل سفارش زوپینی (طبق مستند صفحه ۱۴ و ۱۲–۱۴):
 *   - cartItems.amount: قیمت نهاییِ «هر واحد» پس از تخفیف‌های عمومی/محصول
 *     (OrderItem.price فریز‌شده؛ در نبودش originalPrice). مبلغ خط‌خورده یا
 *     تخفیف محصول در اینجا نمی‌آید.
 *   - discountAmount: فقط تخفیفِ اعمال‌شده از طریق «کد/کوپن سفارش»
 *     (externalSourceAmount نباید تخفیف محصول/فروش‌ویژه را دربربگیرد).
 *   - externalSourceAmount: سهم منبع خارجی (کیف پول/اعتبار باشگاه)؛ مبلغی
 *     که از مسیری غیر از اسنپ‌پی پرداخت می‌شود. نگاشت دقیقِ انواع اعتبار
 *     به این فیلد طبق بخش ۳ مستند نیازمند تأیید اسنپ‌پی است.
 *
 * پس amount نهایی دقیقاً می‌شود:
 *   Σ(count × amount) + shippingCost − discountAmount − externalSourceAmount
 *   = finalPrice − سهم منبع خارجی (مبلغ قابل پرداخت با درگاه)
 */

/** تبدیل مبلغ تومانی (ممکن است اعشاریِ دیتابیس باشد) به ریال صحیح */
export function tomanToIrr(amountToman: number): number {
  const value = Number(amountToman);

  if (!Number.isFinite(value)) {
    throw new Error(`مبلغ تومانی نامعتبر است: ${amountToman}`);
  }

  return Math.round(value * 10);
}

/**
 * تولید transactionId یکتا برای هر تلاش پرداخت.
 *
 * طبق مستند، شناسهٔ تراکنش باید در سیستم پذیرنده unique باشد و اگر طول
 * آن ۱۰ کاراکتر یا بیشتر شد حتماً شامل حرف باشد؛ قالب زیر همیشه حرف دارد:
 *   Z<orderId>T<timestamp-base36><random>
 */
export function generateSnappPayTransactionId(orderId: number): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = randomBytes(3).toString('hex').toUpperCase();

  return `Z${orderId}T${timestamp}${random}`;
}

export interface SnappPayOrderLine {
  /** شناسهٔ پایدار قلم (OrderItem.id) — در Update هم همین شناسه استفاده می‌شود */
  id: number;
  name: string;
  category: string;
  /** قیمت واحدِ نهایی پس از تخفیف‌های محصول/عمومی، تومان (مبلغ خط‌خورده نیست) */
  unitPriceToman: number;
  quantity: number;
}

export interface BuildSnappPayCartInput {
  orderId: number;
  lines: SnappPayOrderLine[];
  /** هزینهٔ ارسال، تومان */
  shippingToman: number;
  /** فقط تخفیف کوپن/کد سفارش (externalSourceAmount نباید تخفیف محصول را شامل شود)، تومان */
  discountToman: number;
  /** سهم منبع خارجی (کیف پول/اعتبار باشگاه)، تومان */
  externalToman: number;
  /** مبلغ قابل پرداخت با درگاه به تومان پس از کسر منابع خارجی */
  expectedPayableToman: number;
  /** کد کمیسیون؛ مقدار پیش‌فرض مستند ۱۰۰ است */
  commissionType: number;
}

export interface BuiltSnappPayCart {
  cartList: SnappPayCart[];
  /** مبلغ نهایی قابل پرداخت با اسنپ‌پی، ریال */
  amount: number;
  discountAmount: number;
  externalSourceAmount: number;
  shippingAmount: number;
  itemsTotalAmount: number;
  totalAmount: number;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} نامعتبر است: ${value}`);
  }

  return value;
}

export function buildSnappPayCart(
  input: BuildSnappPayCartInput,
): BuiltSnappPayCart {
  if (!input.lines.length) {
    throw new Error('سفارش هیچ قلمی برای ارسال به اسنپ‌پی ندارد');
  }

  const commissionType = assertPositiveInteger(
    Number(input.commissionType),
    'commissionType',
  );

  let totalQuantity = 0;

  const cartItems = input.lines.map(line => {
    const count = assertPositiveInteger(Number(line.quantity), 'تعداد قلم');
    const unitAmount = tomanToIrr(line.unitPriceToman);

    if (unitAmount < 0) {
      throw new Error(`قیمت قلم ${line.id} منفی است`);
    }

    totalQuantity += count;

    return {
      id: assertPositiveInteger(Number(line.id), 'شناسه قلم'),
      name: (line.name?.trim() || 'محصول').slice(0, 200),
      category: (line.category?.trim() || 'سایر').slice(0, 100),
      amount: unitAmount,
      count,
      commissionType,
    };
  });

  const itemsTotalAmount = cartItems.reduce(
    (sum, item) => sum + item.amount * item.count,
    0,
  );
  const shippingAmount = tomanToIrr(input.shippingToman);
  const discountAmount = tomanToIrr(input.discountToman);
  const externalSourceAmount = tomanToIrr(input.externalToman);

  if (shippingAmount < 0 || discountAmount < 0 || externalSourceAmount < 0) {
    throw new Error('هزینه ارسال، تخفیف یا سهم کیف پول سفارش منفی است');
  }

  /*
   * طبق مستند هر دو پرچم همیشه true هستند. در مدل زوپینی قیمتِ واحدِ هر
   * قلم شامل ارسال نیست، پس برای اینکه ارسال دقیقاً «یک بار» در totalAmount
   * بیاید (نه دو بار)، مبلغ ارسال را به صورت صریح به totalAmount اضافه
   * می‌کنیم و پرچم isShipmentIncluded=true اعلام می‌کند که ارسال جزءِ مبلغ
   * کل گزارش‌شده است.
   */
  const totalAmount = itemsTotalAmount + shippingAmount;
  const amount = totalAmount - discountAmount - externalSourceAmount;

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(
      `مبلغ قابل پرداخت اسنپ‌پی معتبر نیست: ${amount} ریال ` +
        `(items=${itemsTotalAmount}, shipping=${shippingAmount}, ` +
        `discount=${discountAmount}, external=${externalSourceAmount})`,
    );
  }

  /*
   * کنترل سازگاری با مبلغی که بقیهٔ درگاه‌ها از سفارش می‌گیرند.
   * اختلاف فقط می‌تواند از گرد کردن هر واحد به ریال صحیح باشد
   * (حداکثر نیم ریال برای هر واحد) + گرد کردن جمع‌ها؛ اختلاف بزرگ‌تر
   * یعنی دادهٔ فریز‌شدهٔ سفارش ناسازگار است و نباید پول گرفته شود.
   */
  const expectedAmount = tomanToIrr(input.expectedPayableToman);
  const maxDrift = totalQuantity + 10;

  if (Math.abs(amount - expectedAmount) > maxDrift) {
    throw new Error(
      `جمع اقلام سفارش با مبلغ نهایی آن نمی‌خواند: ` +
        `محاسبه‌شده ${amount} ریال ولی مورد انتظار ${expectedAmount} ریال است`,
    );
  }

  return {
    cartList: [
      {
        cartId: input.orderId,
        cartItems,
        isShipmentIncluded: true,
        isTaxIncluded: true,
        shippingAmount,
        taxAmount: 0,
        totalAmount,
      },
    ],
    amount,
    discountAmount,
    externalSourceAmount,
    shippingAmount,
    itemsTotalAmount,
    totalAmount,
  };
}

/**
 * بازسازی cartList برای سرویس Update اسنپ‌پی.
 *
 * طبق مستند، Update فقط برای «کم کردن» مبلغ/اقلام سفارشِ settle‌شده است
 * و قلمی که کاملاً حذف می‌شود باید از cartItems هم حذف شود. مبلغ واحد هر
 * قلم دقیقاً از همان مقادیری برداشته می‌شود که در درخواست توکن ارسال
 * شده بود تا هیچ مغایرتی با تراکنش اصلی ایجاد نشود.
 */
export function buildSnappPayUpdateCart(
  originalCart: SnappPayCart,
  countByItemId: Map<number, number>,
  discountAmount: number,
  externalSourceAmount: number,
): BuiltSnappPayCart {
  const knownIds = new Set(originalCart.cartItems.map(item => item.id));

  for (const id of countByItemId.keys()) {
    if (!knownIds.has(id)) {
      throw new Error(`قلم ${id} در سبد اصلی تراکنش اسنپ‌پی وجود ندارد`);
    }
  }

  const cartItems = originalCart.cartItems.flatMap(item => {
    const count = countByItemId.get(item.id) ?? item.count;

    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`تعداد جدید قلم ${item.id} نامعتبر است: ${count}`);
    }

    if (count > item.count) {
      throw new Error(
        `در Update اسنپ‌پی تعداد قلم ${item.id} نمی‌تواند از ` +
          `تعداد اولیه (${item.count}) بیشتر شود`,
      );
    }

    return count === 0 ? [] : [{ ...item, count }];
  });

  if (!cartItems.length) {
    throw new Error(
      'در Update اسنپ‌پی حداقل یک قلم باید باقی بماند؛ برای لغو کامل از Cancel استفاده کنید',
    );
  }

  const itemsTotalAmount = cartItems.reduce(
    (sum, item) => sum + item.amount * item.count,
    0,
  );
  const shippingAmount = originalCart.shippingAmount;
  /*
   * هم‌راستا با درخواست توکن، ارسال همیشه جزءِ totalAmount است (پرچم
   * isShipmentIncluded=true). چون قیمت واحدِ اقلام در زوپینی شامل ارسال
   * نیست، مبلغ ارسال را همواره یک‌بار به totalAmount اضافه می‌کنیم تا با
   * محاسبهٔ توکن هم‌خوانی داشته باشد و دوبار جمع نشود.
   */
  const totalAmount = itemsTotalAmount + shippingAmount;
  const amount = totalAmount - discountAmount - externalSourceAmount;

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(
      `مبلغ جدید سفارش برای Update اسنپ‌پی معتبر نیست: ${amount} ریال`,
    );
  }

  return {
    cartList: [
      {
        ...originalCart,
        cartItems,
        totalAmount,
      },
    ],
    amount,
    discountAmount,
    externalSourceAmount,
    shippingAmount,
    itemsTotalAmount,
    totalAmount,
  };
}
