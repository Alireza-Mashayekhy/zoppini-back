// src/rahkaran/rahkaran.controller.ts

import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enum/role.enum';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { RahkaranService } from './rahkaran.service';
import { RahkaranInvoiceSyncService } from './rahkaran-invoice-sync.service';

@Controller('rahkaran')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class RahkaranController {
  constructor(
    private readonly rahkaranService: RahkaranService,
    private readonly invoiceSyncService: RahkaranInvoiceSyncService,
  ) {}

  @Post('auth/login')
  async login() {
    await this.rahkaranService.login();

    return {
      success: true,
      message: 'اتصال به راهکاران با موفقیت انجام شد.',
      ...this.rahkaranService.getAuthState(),
    };
  }

  @Post('auth/tick')
  async tick() {
    const success = await this.rahkaranService.tick();

    return {
      success,
      ...this.rahkaranService.getAuthState(),
    };
  }

  @Get('auth/status')
  status() {
    return (
      this.rahkaranService.getAuthState() || {
        authenticated: false,
      }
    );
  }

  // ============================================================
  // ردیابی ثبت فاکتور سفارش‌ها
  // ============================================================

  /** فهرست ثبت‌های فاکتور ناموفق/ناتمام در راهکاران (جدیدترین اول). */
  @Get('invoice-sync/failed')
  async failedInvoiceSyncs() {
    return this.invoiceSyncService.getFailedSyncs();
  }

  /** وضعیت ثبت فاکتور راهکاران برای یک سفارش مشخص. */
  @Get('invoice-sync/order/:orderId')
  async orderInvoiceSyncStatus(
    @Param('orderId', ParseIntPipe) orderId: number,
  ) {
    const sync = await this.invoiceSyncService.getOrderSyncStatus(orderId);

    return (
      sync || {
        orderId,
        status: 'not_tracked',
      }
    );
  }

  /**
   * retry دستی ثبت فاکتور یک سفارش در راهکاران.
   *
   * اگر فاکتور قبلاً با موفقیت ثبت شده باشد، درخواستی ارسال نمی‌شود
   * (skipped=already_registered) تا فاکتور تکراری ثبت نشود.
   */
  @Post('invoice-sync/order/:orderId/retry')
  async retryInvoiceSync(@Param('orderId', ParseIntPipe) orderId: number) {
    return this.invoiceSyncService.retryOrderSync(orderId);
  }
}
