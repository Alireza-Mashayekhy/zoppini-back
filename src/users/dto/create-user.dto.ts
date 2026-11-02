import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsIranMobileField } from 'src/common/decorators/is-iran-mobile.decorator';

export class CreateUserDto {
  @ApiProperty()
  @IsString()
  fullName: string;

  @IsIranMobileField()
  phone: string;

  /**
   * ایمیل کاملاً اختیاری است. فرانت ممکن است آن را نفرستد، `null` بفرستد یا
   * رشته‌ی خالی بفرستد؛ هر سه باید بدون خطای اعتبارسنجی قبول شوند.
   */
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  })
  @IsEmail({}, { message: 'ایمیل وارد شده معتبر نیست' })
  email?: string | null;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  @MaxLength(5)
  code: string;

  @ApiProperty()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsString() // ← تغییر از @IsDateString() به @IsString()
  birthDate?: string;
}
