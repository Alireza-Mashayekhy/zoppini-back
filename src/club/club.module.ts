// src/club/club.module.ts
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { ClubService } from './club.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5,
    }),
  ],
  providers: [ClubService],
  exports: [ClubService],
})
export class ClubModule {}
