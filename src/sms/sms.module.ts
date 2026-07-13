// src/sms/sms.module.ts
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { SmsService } from './sms.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
    }),
  ],
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
