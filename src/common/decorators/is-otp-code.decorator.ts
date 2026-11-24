import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { toLatinDigits } from '../utils/phone.util';

export function normalizeOtpCode(value: unknown): unknown {
  if (typeof value === 'string' || typeof value === 'number') {
    return toLatinDigits(String(value)).trim();
  }

  return value;
}

export function IsOtpCodeField() {
  return applyDecorators(
    ApiProperty({ example: '12345' }),
    Transform(({ value }) => normalizeOtpCode(value)),
    IsNotEmpty({ message: 'کد تایید الزامی است' }),
    IsString({ message: 'کد تایید باید به صورت متن ارسال شود' }),
    MinLength(5, { message: 'کد تایید باید ۵ رقم باشد' }),
    MaxLength(5, { message: 'کد تایید باید ۵ رقم باشد' }),
    Matches(/^\d{5}$/, { message: 'کد تایید باید ۵ رقم عددی باشد' }),
  );
}
