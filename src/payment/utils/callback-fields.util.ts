import type { Request } from 'express';

/**
 * خواندن یک فیلد از درخواست callback درگاه‌های پرداخت.
 *
 * مقدار هم از بدنهٔ درخواست و هم از query string خوانده می‌شود، چون در
 * مستندات درگاه‌ها تصریح نشده که نتیجه در کدام‌یک برمی‌گردد (ملت نتیجه را
 * POST می‌کند؛ تارا ممکن است با GET برگرداند). اولویت با بدنه است.
 */
export function readCallbackField(req: Request, key: string): string {
  const sources: unknown[] = [req?.body, req?.query];

  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }

    const value = (source as Record<string, unknown>)[key];
    const candidate = Array.isArray(value) ? value[value.length - 1] : value;

    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }

    if (typeof candidate === 'number' || typeof candidate === 'boolean') {
      return String(candidate);
    }
  }

  return '';
}

/**
 * خواندن یک فیلد با چند نام جایگزین.
 *
 * نوشتار پارامترها در مستندات و پیاده‌سازی‌های مختلف متفاوت است
 * (مثلاً SaleOrderId / saleOrderId یا CardHolderPan / CardHolderPAN) و خود
 * مستند ملت هم تأکید می‌کند که «نحوهٔ نگارش و کوچک و بزرگ بودن حروف این
 * پارامترها بسیار حائز اهمیت است».
 */
export function readCallbackFieldAny(req: Request, keys: string[]): string {
  for (const key of keys) {
    const value = readCallbackField(req, key);

    if (value) {
      return value;
    }
  }

  return '';
}
