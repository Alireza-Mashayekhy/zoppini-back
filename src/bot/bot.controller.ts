import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import {
  BOT_API_KEY_HEADER,
  BOT_CHAT_TYPE_HEADER,
  BOT_ORDER_CURRENCY,
  BOT_ORDER_CURRENCY_UNIT,
  BOT_TELEGRAM_USER_HEADER,
  BOT_TIME_ZONE,
  BotScope,
} from './bot.constants';
import { BotScopes } from './decorators/bot-scopes.decorator';
import {
  InventoryQueryDto,
  LowStockQueryDto,
  OrdersQueryDto,
} from './dto/orders-query.dto';
import { RangeQueryDto } from './dto/range-query.dto';
import { BotAuthGuard } from './guards/bot-auth.guard';
import { BotPrincipal } from './services/bot-auth.service';
import { BotCustomersService } from './services/bot-customers.service';
import { BotInventoryService } from './services/bot-inventory.service';
import { BotOrdersService } from './services/bot-orders.service';
import { BotSalesService } from './services/bot-sales.service';
import { getDefaultLowStockThreshold } from './utils/bot-config.util';
import { parseTehranDateRange } from './utils/tehran-date.util';

interface BotRequest {
  botPrincipal?: BotPrincipal;
}

@ApiTags('bot')
@ApiSecurity('bot-api-key')
@ApiHeader({
  name: BOT_TELEGRAM_USER_HEADER,
  required: true,
  description: 'شناسه‌ی عددی تلگرام فراخوان (در allowlist سرور بررسی می‌شود)',
})
@ApiHeader({
  name: BOT_CHAT_TYPE_HEADER,
  required: true,
  description: 'باید دقیقاً private باشد',
})
@ApiHeader({
  name: BOT_API_KEY_HEADER,
  required: true,
  description: 'کلید سرویس‌به‌سرویس ربات (فقط در محیط سرور)',
})
@Controller('bot/v1')
@UseGuards(BotAuthGuard)
@Throttle({ default: { limit: 60, ttl: 60000 } })
export class BotController {
  constructor(
    private readonly salesService: BotSalesService,
    private readonly ordersService: BotOrdersService,
    private readonly inventoryService: BotInventoryService,
    private readonly customersService: BotCustomersService,
  ) {}

  /**
   * فقط برای بررسی اتصال و تنظیمات؛ هیچ داده‌ی فروشگاهی برنمی‌گرداند.
   */
  @Get('health')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'بررسی سلامت و پیکربندی امن API ربات' })
  health(@Req() request: BotRequest) {
    return {
      status: 'ok',
      time: new Date().toISOString(),
      timeZone: BOT_TIME_ZONE,
      orderCurrency: BOT_ORDER_CURRENCY,
      orderCurrencyUnit: BOT_ORDER_CURRENCY_UNIT,
      defaultLowStockThreshold: getDefaultLowStockThreshold(),
      role: request.botPrincipal?.role ?? null,
      scopes: request.botPrincipal?.scopes ?? [],
      readOnly: true,
    };
  }

  @Get('reports/sales')
  @Header('Cache-Control', 'no-store')
  @BotScopes(BotScope.REPORTS)
  @ApiOperation({
    summary: 'گزارش فروش در بازه‌ی میلادی؛ مرز روزها Asia/Tehran',
  })
  sales(@Query() query: RangeQueryDto) {
    const range = parseTehranDateRange(query.from, query.to);
    return this.salesService.getSalesReport(range);
  }

  @Get('reports/customers')
  @Header('Cache-Control', 'no-store')
  @BotScopes(BotScope.REPORTS)
  @ApiOperation({ summary: 'آمار تجمیعی مشتریان در بازه' })
  customers(@Query() query: RangeQueryDto) {
    const range = parseTehranDateRange(query.from, query.to);
    return this.customersService.getCustomerReport(range);
  }

  @Get('orders')
  @Header('Cache-Control', 'no-store')
  @BotScopes(BotScope.ORDERS)
  @ApiOperation({ summary: 'جست‌وجوی سفارش با شماره (نتایج خلاصه)' })
  orders(@Query() query: OrdersQueryDto) {
    return this.ordersService.searchOrders(query);
  }

  @Get('orders/:orderNumber')
  @Header('Cache-Control', 'no-store')
  @BotScopes(BotScope.ORDERS)
  @ApiOperation({ summary: 'جزئیات کم‌داده‌ی سفارش با شماره' })
  order(@Param('orderNumber') orderNumber: string) {
    return this.ordersService.getOrderByNumber(orderNumber);
  }

  @Get('inventory/low-stock')
  @Header('Cache-Control', 'no-store')
  @BotScopes(BotScope.INVENTORY)
  @ApiOperation({ summary: 'واریانت‌های کم‌موجود یا ناموجود' })
  lowStock(@Query() query: LowStockQueryDto) {
    return this.inventoryService.getLowStock(query);
  }

  @Get('inventory')
  @Header('Cache-Control', 'no-store')
  @BotScopes(BotScope.INVENTORY)
  @ApiOperation({ summary: 'جست‌وجوی محصول/SKU و موجودی قابل‌فروش' })
  inventory(@Query() query: InventoryQueryDto) {
    return this.inventoryService.searchInventory(query);
  }
}
