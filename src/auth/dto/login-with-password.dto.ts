import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';
import { IsIranMobileField } from 'src/common/decorators/is-iran-mobile.decorator';

export class LoginWithPasswordDto {
  @IsIranMobileField()
  phone: string;

  @ApiProperty()
  @IsNotEmpty()
  password: string;
}
