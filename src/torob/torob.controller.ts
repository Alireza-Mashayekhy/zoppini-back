import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { RawResponse } from 'src/common/decorators/raw-response.decorator';

import { TorobResponse } from './interfaces/torob-api.interface';
import { TorobService } from './torob.service';
import { TorobExceptionFilter } from './torob-api.exception';
import { TorobTokenGuard } from './torob-token.guard';

/**
 * درگاه TorobAPI نسخه ۳
 * مستند: https://panel.torob.com/s/torobApiV3
 *
 * آدرس نهایی (بدون پیشوند global `api`):
 *   POST https://<api-domain>/torob_api/v3/products
 */
@Controller('torob_api/v3')
@SkipThrottle()
@UseFilters(TorobExceptionFilter)
export class TorobController {
  constructor(private readonly torobService: TorobService) {}

  @Post('products')
  @HttpCode(HttpStatus.OK)
  @RawResponse()
  @UseGuards(TorobTokenGuard)
  async getProducts(@Body() body: unknown): Promise<TorobResponse> {
    return this.torobService.handleRequest(body);
  }
}
