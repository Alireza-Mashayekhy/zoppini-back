// src/rahkaran/rahkaran.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';

import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enum/role.enum';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { RahkaranService } from './rahkaran.service';

@Controller('rahkaran')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin)
export class RahkaranController {
  constructor(private readonly rahkaranService: RahkaranService) {}

  // ========== احراز هویت ==========
  @Post('auth/login')
  async login(
    @Body()
    body: {
      username?: string;
      password?: string;
      machineName?: string;
    },
  ) {
    const username = body.username || process.env.RAHKARAN_USERNAME;
    const password = body.password || process.env.RAHKARAN_PASSWORD;
    const machine = body.machineName || process.env.RAHKARAN_MACHINE_NAME;

    if (!username || !password || !machine) {
      throw new Error('اطلاعات احراز هویت کامل نیست.');
    }

    const auth = await this.rahkaranService.authenticate(username, password);
    if (!auth) throw new Error('احراز هویت ناموفق');
    const cashier = await this.rahkaranService.cashierLogin(machine);
    return { success: cashier, message: cashier ? 'ورود موفق' : 'ورود ناموفق' };
  }

  // ========== هدف ۱: دریافت فاکتورهای مشتری ==========
  @Get('invoices')
  async getCustomerInvoices(@Request() req) {
    const userId = req.user.id;
    const invoices = await this.rahkaranService.getCustomerInvoices(userId);
    return { success: true, invoices };
  }

  // ========== هدف ۲: همگام‌سازی محصولات ==========
  @Post('products/sync')
  async syncProducts(@Body() body: { shopId?: number; storeId?: number }) {
    const result = await this.rahkaranService.syncProducts(
      body.shopId,
      body.storeId,
    );
    return { message: 'همگام‌سازی محصولات انجام شد.', ...result };
  }

  // ========== هدف ۴: به‌روزرسانی آنی محصول ==========
  @Post('product/update/:productId')
  async updateProduct(
    @Param('productId') productId: number,
    @Body() body: { storeId?: number },
  ) {
    await this.rahkaranService.updateProductStockAndPrice(
      productId,
      body.storeId,
    );
    return { message: 'محصول با موفقیت به‌روز شد.' };
  }

  // ========== هدف ۳: ایجاد عضو وفادار برای کاربر ==========
  @Post('loyalty/create')
  async createLoyalty(@Body() body: { userId: number; patternId?: number }) {
    const loyaltyId = await this.rahkaranService.createLoyaltyMemberForUser(
      body.userId,
      body.patternId,
    );
    return { success: true, loyaltyId };
  }

  // ========== موجودی لحظه‌ای ==========
  @Get('product/remaining')
  async getRemaining(
    @Query() query: { productId: number; storeId?: number; date?: string },
  ) {
    const remaining = await this.rahkaranService.getRemaining(
      query.productId,
      query.storeId || 1,
      query.date,
    );
    return { remaining };
  }

  // ========== قیمت لحظه‌ای ==========
  @Get('product/price')
  async getPrice(@Query() query: { productId: number; customerId?: number }) {
    const price = await this.rahkaranService.getProductPrice(
      query.productId,
      query.customerId || 0,
    );
    return { price };
  }
}
