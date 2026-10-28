import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

import { IRAN_MOBILE_REGEX, normalizeIranMobile } from '../utils/phone.util';

export const MOBILE_MESSAGES = {
  required: 'شماره موبایل الزامی است',
  notString: 'شماره موبایل باید به صورت متن ارسال شود',
  invalid: 'شماره موبایل معتبر نیست؛ باید ۱۱ رقم و با ۰۹ شروع شود',
} as const;

/**
 * فیلد «شماره موبایل» با یکدست‌سازی خودکار.
 *
 * هم‌زمان: تبدیل اعداد فارسی/عربی و پیش‌شماره‌ی +۹۸/۰۰۹۸/۹۸ به قالب `09xxxxxxxxx`،
 * الزامی بودن، رشته بودن و تطابق با الگوی موبایل ایران — همراه با پیام‌های فارسی
 * و مستندسازی Swagger.
 *
 * نمونه استفاده:
 *   @IsIranMobileField()
 *   phone: string;
 */
export function IsIranMobileField(example = '09121234567') {
  return applyDecorators(
    ApiProperty({
      type: String,
      example,
      description:
        'شماره موبایل ایران؛ ۱۱ رقم و با ۰۹ شروع می‌شود (اعداد فارسی و پیش‌شماره +۹۸ هم پذیرفته می‌شود)',
    }),
    Transform(({ value }) => normalizeIranMobile(value)),
    IsNotEmpty({ message: MOBILE_MESSAGES.required }),
    IsString({ message: MOBILE_MESSAGES.notString }),
    Matches(IRAN_MOBILE_REGEX, { message: MOBILE_MESSAGES.invalid }),
  );
}
