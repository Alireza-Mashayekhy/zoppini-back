import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { IsIranMobileField } from 'src/common/decorators/is-iran-mobile.decorator';
import { IsOtpCodeField } from 'src/common/decorators/is-otp-code.decorator';

export class CreateUserDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
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

  @IsOtpCodeField()
  code: string;

  @ApiProperty()
  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsString() // ← تغییر از @IsDateString() به @IsString()
  birthDate?: string;
}
