import { IsIranMobileField } from 'src/common/decorators/is-iran-mobile.decorator';

export class SendOtpDto {
  @IsIranMobileField()
  phone: string;
}
