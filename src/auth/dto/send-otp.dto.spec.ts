import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { MOBILE_MESSAGES } from 'src/common/decorators/is-iran-mobile.decorator';

import { SendOtpDto } from './send-otp.dto';

/**
 * رگرسیون باگ «شماره تلفن باید ۱۱ رقمی باشد» روی شماره‌ی درست:
 * علت واقعی، نرسیدن/پارس‌نشدن بدنه بود نه طول شماره. این تست‌ها مطمئن می‌شوند
 * قالب‌های ورودی مختلف (اعداد فارسی، پیش‌شماره‌ی بین‌المللی، عدد خام) پذیرفته
 * می‌شوند و پیام خطا هم فارسی و گویاست.
 */
describe('SendOtpDto', () => {
  const pipe = new ValidationPipe({ transform: true });

  const validate = async (body: unknown): Promise<SendOtpDto> =>
    pipe.transform(body, { type: 'body', metatype: SendOtpDto });

  const messagesOf = async (body: unknown): Promise<string[]> => {
    try {
      await validate(body);
      return [];
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        message: string | string[];
      };
      return Array.isArray(response.message)
        ? response.message
        : [response.message];
    }
  };

  it('شماره‌ی ۱۱ رقمی معتبر را می‌پذیرد و نرمال‌شده تحویل می‌دهد', async () => {
    await expect(validate({ phone: '09918690340' })).resolves.toMatchObject({
      phone: '09918690340',
    });
  });

  it('اعداد فارسی، پیش‌شماره‌ی +۹۸، فاصله و عدد خام را هم می‌پذیرد', async () => {
    for (const phone of [
      '۰۹۹۱۸۶۹۰۳۴۰',
      '+989918690340',
      '00989918690340',
      '0991 869 0340',
      '9918690340',
      9918690340,
    ]) {
      await expect(validate({ phone })).resolves.toMatchObject({
        phone: '09918690340',
      });
    }
  });

  it('نبودن فیلد phone را با پیام فارسی گزارش می‌کند', async () => {
    expect(await messagesOf({})).toContain(MOBILE_MESSAGES.required);
  });

  it('شماره‌ی کوتاه/بلند یا نامعتبر را با پیام فارسی رد می‌کند', async () => {
    for (const phone of ['0991869034', '009918690340', '08918690340', 'abcd']) {
      expect(await messagesOf({ phone })).toContain(MOBILE_MESSAGES.invalid);
    }
  });

  it('پیام‌های خطا انگلیسی نیستند', async () => {
    const messages = await messagesOf({});
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).not.toMatch(/must be|should not be/);
    }
  });
});
