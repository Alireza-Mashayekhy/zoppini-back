/**
 * ابزارهای پرداخت دیجی‌پی و نمایش خوانای آن‌ها.
 *
 * مستند UPG دو دنیای متفاوت از «نوع» دارد که نباید با هم قاطی شوند:
 * - `type` در callback (جدول ۱۲): 0=IPG، 5=CKEDIT/CPG، 11=Wallet، 13=BNPL، 24=Credit-Card
 * - `paymentGateway` در پاسخ verify (جدول ۱۶): 3=Wallet، 4=CPG، 10=BNPL
 *
 * این فایل نگاشت هر دو به یک برچسب فارسی + تعداد اقساط را نگه می‌دارد تا
 * سرویس پرداخت و پنل ادمین از یک منبع استفاده کنند.
 */

export const DIGIPAY_PURCHASE_TYPE_LABELS: Record<number, string> = {
  0: 'درگاه اینترنتی دیجی‌پی',
  5: 'اعتبار دیجی‌پی (CPG)',
  11: 'کیف پول دیجی‌پی',
  13: 'خرید اعتباری دیجی‌پی (BNPL)',
  24: 'کارت اعتباری دیجی‌پی',
};

const DIGIPAY_GATEWAY_LABELS: Record<number, string> = {
  3: 'کیف پول دیجی‌پی',
  4: 'اعتبار دیجی‌پی (قسطی)',
  10: 'خرید اعتباری دیجی‌پی (BNPL)',
};

export type DigipayInstrumentInfo = {
  /** برچسب فارسی ابزار پرداخت */
  label: string;
  /** تعداد اقساط؛ 1 = یک‌جا، 4 = چهار قسط، null = نامشخص */
  installments: number | null;
  /** تأمین‌کنندهٔ اعتبار (DIGIPAY، PARSIAN_BANK، …) */
  creditProvider: string | null;
};

/**
 * توضیح ابزار پرداخت یک تراکنش دیجی‌پی.
 * اگر هیچ اطلاعاتی موجود نباشد `null` برمی‌گردد.
 */
export function describeDigipayPurchase(input: {
  digipayPaymentGateway?: number | null;
  digipayPurchaseType?: number | null;
  repaymentOption?: number | null;
  creditProvider?: string | null;
}): DigipayInstrumentInfo | null {
  /*
   * مهم: `Number(null)` و `Number(undefined)` صفر می‌شوند و همین می‌توانست
   * هر پرداخت غیردیجی‌پی (که این ستون‌ها NULL دارند) را «درگاه اینترنتی
   * دیجی‌پی» با یک قسط نشان دهد. پس فقط مقدارهای واقعاً عددی پذیرفته می‌شوند.
   */
  const toOptionalNumber = (value: number | null | undefined): number =>
    value === null || value === undefined || value === ('' as never)
      ? Number.NaN
      : Number(value);

  const gateway = toOptionalNumber(input.digipayPaymentGateway);
  const purchaseType = toOptionalNumber(input.digipayPurchaseType);

  const label =
    (Number.isFinite(gateway) ? DIGIPAY_GATEWAY_LABELS[gateway] : undefined) ??
    (Number.isFinite(purchaseType)
      ? DIGIPAY_PURCHASE_TYPE_LABELS[purchaseType]
      : undefined) ??
    null;

  if (!label) {
    return null;
  }

  const repaymentOption = toOptionalNumber(input.repaymentOption);
  let installments: number | null = null;

  if (Number.isFinite(repaymentOption)) {
    // مستند: 0 = تک‌مرحله‌ای (یک‌جا)، 1 = چندمرحله‌ای (۴ قسط)
    installments = repaymentOption === 1 ? 4 : repaymentOption === 0 ? 1 : null;
  }

  return {
    label,
    installments,
    creditProvider: input.creditProvider ?? null,
  };
}
