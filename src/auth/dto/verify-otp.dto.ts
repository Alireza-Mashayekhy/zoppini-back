import { IsIranMobileField } from 'src/common/decorators/is-iran-mobile.decorator';
import { IsOtpCodeField } from 'src/common/decorators/is-otp-code.decorator';

export class SendVerifyOtp {
  @IsIranMobileField()
  phone: string;

  @IsOtpCodeField()
  code: string;
}
