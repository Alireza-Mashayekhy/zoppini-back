import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { RawResponse } from 'src/common/decorators/raw-response.decorator';

import { validGrantId } from './torob-attribution.util';
import { TorobOrderGuard } from './torob-order.guard';
import { TorobOrderTrackingService } from './torob-order-tracking.service';

@Controller('torob')
export class TorobOrderTrackingController {
  constructor(private readonly service: TorobOrderTrackingService) {}

  @Get('v1/orders')
  @UseGuards(TorobOrderGuard)
  @Header('Cache-Control', 'no-store')
  @RawResponse()
  list(
    @Query('purchase_timestamp_gt') timestamp: unknown,
    @Query('limit') limit: unknown,
  ) {
    return this.service.list(timestamp, limit);
  }

  // Server-to-server only. This secret is never sent to the browser.
  @Post('internal/attribution')
  async grant(
    @Headers('x-torob-internal-secret') supplied: string,
    @Body() body: { action?: unknown; grantId?: unknown },
  ) {
    const secret = process.env.TOROB_ATTRIBUTION_SECRET;
    if (
      !secret ||
      secret.length < 32 ||
      typeof supplied !== 'string' ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(secret) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
    )
      throw new UnauthorizedException();
    if (
      !body ||
      !validGrantId(body.grantId) ||
      !['register', 'revoke'].includes(String(body.action))
    )
      throw new ForbiddenException();
    if (body.action === 'revoke') await this.service.revoke(body.grantId);
    else {
      if (
        process.env.TOROB_TRACKING_ENABLED !== 'true' ||
        !(await this.service.register(body.grantId))
      )
        throw new ForbiddenException();
    }
    return { ok: true };
  }
}
