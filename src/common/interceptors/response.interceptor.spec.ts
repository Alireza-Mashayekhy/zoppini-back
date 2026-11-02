import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';

import { ResponseInterceptor } from './response.interceptor';

const buildContext = (statusCode = 200) =>
  ({
    switchToHttp: () => ({ getResponse: () => ({ statusCode }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as unknown as ExecutionContext;

const run = async (result: unknown) => {
  const interceptor = new ResponseInterceptor(new Reflector());
  const next: CallHandler = { handle: () => of(result) };

  return lastValueFrom(interceptor.intercept(buildContext(), next));
};

describe('ResponseInterceptor — پیامهای جانبی راهنمای محصولات', () => {
  it('هشدار حذف سایز و آمار وابستگیها را به ادمین میرساند', async () => {
    const body = await run({
      message: 'جدول سایزبندی با موفقیت ذخیره شد.',
      data: { id: 7, name: 'سایزبندی پیراهن' },
      warnings: ['ستون «M» در ۲ تغییر اختصاصی استفاده شده است.'],
      dependents: { categories: 3, products: 12 },
    });

    expect(body.status).toBe(200);
    expect(body.message).toBe('جدول سایزبندی با موفقیت ذخیره شد.');
    expect(body.data).toEqual({ id: 7, name: 'سایزبندی پیراهن' });
    expect(body.warnings).toEqual([
      'ستون «M» در ۲ تغییر اختصاصی استفاده شده است.',
    ]);
    expect(body.dependents).toEqual({ categories: 3, products: 12 });
  });

  it('وقتی هشداری نیست فیلد اضافی ساخته نمیشود و شکل معمول حفظ میشود', async () => {
    const body = await run({ message: 'success', data: { id: 1 } });

    expect(body).toEqual({
      status: 200,
      message: 'success',
      data: { id: 1 },
      pagination: undefined,
    });
    expect('warnings' in body).toBe(false);
    expect('dependents' in body).toBe(false);
  });
});
