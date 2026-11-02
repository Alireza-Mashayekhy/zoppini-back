import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { CreateUserDto } from './create-user.dto';

/** رگرسیون: ایمیل در فرانت اختیاری است ولی بکاند آن را اجباری میکرد. */
describe('CreateUserDto — ایمیل اختیاری', () => {
  const pipe = new ValidationPipe({ transform: true });

  const validate = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: CreateUserDto });

  const valid = {
    fullName: 'علی تست',
    phone: '09918690340',
    code: '12345',
    password: 'secret123',
  };

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

  it('نبودن ایمیل، null، رشتهی خالی و فقط فاصله همگی پذیرفته میشوند', async () => {
    expect(await messagesOf(valid)).toEqual([]);
    expect(await messagesOf({ ...valid, email: null })).toEqual([]);
    expect(await messagesOf({ ...valid, email: '' })).toEqual([]);
    expect(await messagesOf({ ...valid, email: '   ' })).toEqual([]);
  });

  it('ایمیل خالی و فقط فاصله به undefined تبدیل میشوند', async () => {
    await expect(validate({ ...valid, email: '' })).resolves.toMatchObject({
      email: undefined,
    });
    await expect(validate({ ...valid, email: '   ' })).resolves.toMatchObject({
      email: undefined,
    });
  });

  it('ایمیل معتبر trim میشود', async () => {
    await expect(
      validate({ ...valid, email: '  user@example.com ' }),
    ).resolves.toMatchObject({ email: 'user@example.com' });
  });

  it('ایمیل نامعتبر همچنان با پیام فارسی رد میشود', async () => {
    expect(await messagesOf({ ...valid, email: 'not-an-email' })).toContain(
      'ایمیل وارد شده معتبر نیست',
    );
  });

  it('تاریخ تولد هم اختیاری است (رشتهی خالی قبول میشود)', async () => {
    expect(await messagesOf({ ...valid, birthDate: '' })).toEqual([]);
  });
});
