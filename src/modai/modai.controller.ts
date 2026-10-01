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

import { ModaiResponse } from './interfaces/modai-api.interface';
import { ModaiService } from './modai.service';
import { ModaiExceptionFilter } from './modai-api.exception';
import { ModaiTokenGuard } from './modai-token.guard';

/**
 * درگاه مدآی (ModAI) نسخه ۱
 *
 * آدرس نهایی (با پیشوند global `api`):
 *   POST https://<api-domain>/api/modai-api/v1/products
 *
 * خروجی خام برگردانده می‌شود (`@RawResponse`) تا ResponseInterceptor عمومی
 * آن را داخل `{ status, message, data }` نپیچد؛ مدآی بدنهٔ دقیق مستند را
 * انتظار دارد.
 */
@Controller('modai-api/v1')
@SkipThrottle()
@UseFilters(ModaiExceptionFilter)
export class ModaiController {
  constructor(private readonly modaiService: ModaiService) {}

  @Post('products')
  @HttpCode(HttpStatus.OK)
  @RawResponse()
  @UseGuards(ModaiTokenGuard)
  async getProducts(@Body() body: unknown): Promise<ModaiResponse> {
    return this.modaiService.handleRequest(body);
  }

  @Post('products-by-uniques')
  @HttpCode(HttpStatus.OK)
  @RawResponse()
  @UseGuards(ModaiTokenGuard)
  async getProductsByUniques(@Body() body: unknown): Promise<ModaiResponse> {
    return this.modaiService.handleProductsByUniques(body);
  }
}
