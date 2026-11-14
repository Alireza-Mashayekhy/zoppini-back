import {
  buildApiUrl,
  collapseDuplicateApiSegment,
  normalizePublicBaseUrl,
  resolveGatewayCallbackUrl,
} from './callback-url.util';

describe('callback-url.util', () => {
  it('آدرس پایهٔ بدون /api را مثل قبل استفاده می‌کند', () => {
    expect(
      resolveGatewayCallbackUrl({
        baseUrl: 'https://zoppinico.com',
        pathAfterApi: 'payment/callback/snappay',
      }),
    ).toBe('https://zoppinico.com/api/payment/callback/snappay');
  });

  it('اگر APP_URL خودش /api داشته باشد آدرس /api/api نمی‌سازد', () => {
    expect(
      resolveGatewayCallbackUrl({
        baseUrl: 'https://zoppinico.com/api',
        pathAfterApi: 'payment/callback/snappay',
      }),
    ).toBe('https://zoppinico.com/api/payment/callback/snappay');

    expect(
      resolveGatewayCallbackUrl({
        baseUrl: 'https://zoppinico.com/api/',
        pathAfterApi: '/payment/callback/mellat/',
      }),
    ).toBe('https://zoppinico.com/api/payment/callback/mellat');
  });

  it('مقدار صریح درگاه دست‌نخورده می‌ماند (به‌جز اسلش انتهایی و /api تکراری)', () => {
    expect(
      resolveGatewayCallbackUrl({
        explicit: 'https://pay.example.com/api/payment/callback/tara/',
        baseUrl: 'https://zoppinico.com',
        pathAfterApi: 'payment/callback/tara',
      }),
    ).toBe('https://pay.example.com/api/payment/callback/tara');

    // اگر همین مقدار صریح اشتباهاً با /api تکراری ثبت شده باشد، اصلاح می‌شود
    expect(
      resolveGatewayCallbackUrl({
        explicit: 'https://zoppinico.com/api/api/payment/callback/snappay',
        pathAfterApi: 'payment/callback/snappay',
      }),
    ).toBe('https://zoppinico.com/api/payment/callback/snappay');
  });

  it('بدون تنظیم هیچ آدرسی رشتهٔ خالی برمی‌گرداند تا خطای پیکربندی داده شود', () => {
    expect(
      resolveGatewayCallbackUrl({ pathAfterApi: 'payment/callback/snappay' }),
    ).toBe('');
    expect(buildApiUrl(undefined, 'payment/callback/snappay')).toBe('');
    expect(normalizePublicBaseUrl('   ')).toBe('');
  });

  it('فقط قطعهٔ /api تکراری را جمع می‌کند و به دامنه دست نمی‌زند', () => {
    expect(collapseDuplicateApiSegment('https://api.example.com/api/x')).toBe(
      'https://api.example.com/api/x',
    );
    expect(
      collapseDuplicateApiSegment('https://api.example.com/api/api/api/x'),
    ).toBe('https://api.example.com/api/x');
  });

  it('آدرس پایه با مسیر اضافه (پروکسی داخلی) را هم می‌پذیرد', () => {
    expect(
      resolveGatewayCallbackUrl({
        baseUrl: 'http://backend:3000/api',
        pathAfterApi: 'payment/callback/digipay',
      }),
    ).toBe('http://backend:3000/api/payment/callback/digipay');
  });
});
