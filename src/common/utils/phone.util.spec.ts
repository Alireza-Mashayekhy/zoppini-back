import { isIranMobile, normalizeIranMobile, toLatinDigits } from './phone.util';

describe('phone.util', () => {
  describe('toLatinDigits', () => {
    it('ارقام فارسی و عربی را به لاتین تبدیل می‌کند', () => {
      expect(toLatinDigits('۰۹۹۱۸۶۹۰۳۴۰')).toBe('09918690340');
      expect(toLatinDigits('٠٩٩١٨٦٩٠٣٤٠')).toBe('09918690340');
      expect(toLatinDigits('0912abc')).toBe('0912abc');
    });
  });

  describe('normalizeIranMobile', () => {
    it('شماره‌ی استاندارد را تغییر نمی‌دهد', () => {
      expect(normalizeIranMobile('09918690340')).toBe('09918690340');
    });

    it('اعداد فارسی و عربی را یکدست می‌کند', () => {
      expect(normalizeIranMobile('۰۹۹۱۸۶۹۰۳۴۰')).toBe('09918690340');
      expect(normalizeIranMobile('٠٩٩١٨٦٩٠٣٤٠')).toBe('09918690340');
    });

    it('فاصله، خط‌تیره، پرانتز و نقطه را حذف می‌کند', () => {
      expect(normalizeIranMobile('0991-869 0340')).toBe('09918690340');
      expect(normalizeIranMobile(' 0991.869.0340 ')).toBe('09918690340');
      expect(normalizeIranMobile('(0991) 8690340')).toBe('09918690340');
    });

    it('پیش‌شماره‌ی بین‌المللی را به قالب داخلی تبدیل می‌کند', () => {
      expect(normalizeIranMobile('+989918690340')).toBe('09918690340');
      expect(normalizeIranMobile('+98 991 869 0340')).toBe('09918690340');
      expect(normalizeIranMobile('00989918690340')).toBe('09918690340');
      expect(normalizeIranMobile('989918690340')).toBe('09918690340');
    });

    it('شماره‌ی بدون صفر ابتدای ۱۰ رقمی را کامل می‌کند', () => {
      expect(normalizeIranMobile('9918690340')).toBe('09918690340');
    });

    it('عدد را به رشته تبدیل می‌کند', () => {
      expect(normalizeIranMobile(9918690340)).toBe('09918690340');
    });

    it('ورودی غیر متنی را دست‌نخورده برمی‌گرداند تا اعتبارسنجی پیام درست بدهد', () => {
      expect(normalizeIranMobile(undefined)).toBeUndefined();
      expect(normalizeIranMobile(null)).toBeNull();
      expect(normalizeIranMobile({})).toEqual({});
    });
  });

  describe('isIranMobile', () => {
    it('شماره‌های معتبر را می‌پذیرد', () => {
      expect(isIranMobile('09918690340')).toBe(true);
      expect(isIranMobile('۰۹۹۱۸۶۹۰۳۴۰')).toBe(true);
      expect(isIranMobile('+989918690340')).toBe(true);
    });

    it('شماره‌های نامعتبر را رد می‌کند', () => {
      expect(isIranMobile('0991869034')).toBe(false); // ۱۰ رقم
      expect(isIranMobile('009918690340')).toBe(false); // ۱۲ رقم
      expect(isIranMobile('08918690340')).toBe(false); // با ۰۸ شروع شده
      expect(isIranMobile('')).toBe(false);
      expect(isIranMobile(undefined)).toBe(false);
    });
  });
});
