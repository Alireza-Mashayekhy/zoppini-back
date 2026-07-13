// src/b2b/b2b.controller.ts
import { Body, Controller, Post } from '@nestjs/common';

import { B2BService } from './b2b-request.service';
import { CreateB2BRequestDto } from './dto/create-b2b-request.dto';

@Controller('b2b')
export class B2BController {
  constructor(private readonly b2bService: B2BService) {}

  // مسیر عمومی برای ثبت درخواست
  @Post()
  async create(@Body() dto: CreateB2BRequestDto) {
    return this.b2bService.create(dto);
  }
}
