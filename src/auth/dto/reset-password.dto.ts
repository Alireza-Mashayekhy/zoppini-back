import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, MaxLength, MinLength } from 'class-validator';
import { IsIranMobileField } from 'src/common/decorators/is-iran-mobile.decorator';

export class ResetPasswordDto {
  @IsIranMobileField()
  phone: string;

  @ApiProperty()
  @IsNotEmpty()
  @MaxLength(5)
  @MinLength(5)
  code: string;

  @ApiProperty()
  @IsNotEmpty()
  @MinLength(6)
  newPassword: string;
}
