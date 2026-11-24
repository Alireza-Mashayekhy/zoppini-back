import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { IsIranMobileField } from 'src/common/decorators/is-iran-mobile.decorator';
import { IsOtpCodeField } from 'src/common/decorators/is-otp-code.decorator';

export class ResetPasswordDto {
  @IsIranMobileField()
  phone: string;

  @IsOtpCodeField()
  code: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @MinLength(6)
  newPassword: string;
}
