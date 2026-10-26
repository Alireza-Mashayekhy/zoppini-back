import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { RawResponse } from 'src/common/decorators/raw-response.decorator';
import { OrderStatus } from 'src/order/entities/order.entity';
import { DataSource } from 'typeorm';

import {
  BotAnyPrivateActor,
  BotRequirePermissions,
  BotSystemOrPermissions,
  BotSystemWorkerOnly,
} from './bot-access.decorator';
import { BotAccessService } from './bot-access.service';
import { AckEventItemInput, BotEventsService } from './bot-events.service';
import type {
  BotReportsReader,
  BotSystemHealthDto,
  CsvExportResult,
  DateRange,
  InventoryCategoryFilter,
} from './bot-reports.contract';
import {
  BOT_REPORTS_READER,
  BOT_REPORTS_TIMEZONE,
} from './bot-reports.contract';
import type { BotAuthorizedRequest } from './bot-role.guard';
import { BotRoleGuard } from './bot-role.guard';
import { BotServiceKeyGuard } from './bot-service-key.guard';
import type { UpdateBotSettingsInput } from './bot-settings.service';
import { BotSettingsService } from './bot-settings.service';
import { currentDateInTehran, parseDateOnlyUtc } from './bot-time.util';
import { BotOutboxStatus } from './entities/bot-outbox-event.entity';

const MAX_RANGE_DAYS = 366;
const ALLOWED_ORDER_STATUSES = new Set<string>(Object.values(OrderStatus));
const ALLOWED_INVENTORY_CATEGORIES = new Set<InventoryCategoryFilter>([
  'out',
  'low',
  'in',
  'all',
]);
const ALLOWED_OUTBOX_STATUSES = new Set<string>(Object.values(BotOutboxStatus));

export function validateDateRange(from?: string, to?: string): DateRange {
  if (!from || !to) {
    throw new BadRequestException(
      'from and to must be valid YYYY-MM-DD dates, with from <= to.',
    );
  }

  const fromTime = parseDateOnlyUtc(from);
  const toTime = parseDateOnlyUtc(to);

  if (fromTime == null || toTime == null || fromTime > toTime) {
    throw new BadRequestException(
      'from and to must be valid YYYY-MM-DD dates, with from <= to.',
    );
  }

  const rangeDays = (toTime - fromTime) / 86_400_000 + 1;

  if (rangeDays > MAX_RANGE_DAYS) {
    throw new BadRequestException(
      `date range must not exceed ${MAX_RANGE_DAYS} days.`,
    );
  }

  return { from, to, timezone: BOT_REPORTS_TIMEZONE };
}

function validatePage(rawPage?: string, defaultPage = 1): number {
  if (rawPage === undefined || rawPage === '') {
    return defaultPage;
  }

  const page = Number(rawPage);

  if (!Number.isInteger(page) || page < 1 || page > 10_000) {
    throw new BadRequestException(
      'page must be an integer between 1 and 10000.',
    );
  }

  return page;
}

function validateLimit(
  rawLimit?: string,
  defaultLimit = 10,
  maxLimit = 20,
): number {
  if (rawLimit === undefined || rawLimit === '') {
    return defaultLimit;
  }

  const limit = Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new BadRequestException(
      `limit must be an integer between 1 and ${maxLimit}.`,
    );
  }

  return limit;
}

function validateOptionalThreshold(rawThreshold?: string): number | undefined {
  if (rawThreshold === undefined || rawThreshold === '') {
    return undefined;
  }

  const threshold = Number(rawThreshold);

  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 10_000) {
    throw new BadRequestException(
      'threshold must be an integer between 0 and 10000.',
    );
  }

  return threshold;
}

function validateSearchQuery(rawQuery?: string): string | undefined {
  if (rawQuery === undefined || rawQuery === '') {
    return undefined;
  }

  const trimmed = String(rawQuery).trim();

  if (trimmed.length > 100) {
    throw new BadRequestException(
      'search query must not exceed 100 characters.',
    );
  }

  if (/\p{Cc}/u.test(trimmed)) {
    throw new BadRequestException('search query contains invalid characters.');
  }

  return trimmed || undefined;
}

function sendCsvOrJson(
  req: BotAuthorizedRequest,
  res: Response,
  exportResult: CsvExportResult,
): void {
  res.setHeader('X-Total-Records', String(exportResult.totalRecords));
  res.setHeader('X-Report-Generated-At', exportResult.generatedAt);
  res.setHeader('X-Suggested-Filename', exportResult.filename);

  const accept = String(req.headers?.accept ?? '').toLowerCase();

  if (accept.includes('text/csv')) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${exportResult.filename}"`,
    );
    res.status(200).send(exportResult.csvContent);
    return;
  }

  res.status(200).json(exportResult);
}

@Controller('bot/v1')
@UseGuards(BotServiceKeyGuard, BotRoleGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@RawResponse()
export class BotReportsController {
  private readonly logger = new Logger(BotReportsController.name);

  constructor(
    @Inject(BOT_REPORTS_READER) private readonly reports: BotReportsReader,
    private readonly accessService: BotAccessService,
    private readonly settingsService: BotSettingsService,
    private readonly eventsService: BotEventsService,
    private readonly dataSource: DataSource,
  ) {}

  /* ---------------------------- هویت و نقش ---------------------------- */

  @Get('me')
  @BotAnyPrivateActor()
  me(@Req() req: BotAuthorizedRequest) {
    return this.accessService.getCallerProfile(req.botAuth!.baleUserId!);
  }

  /* ------------------------------ سفارش‌ها ------------------------------ */

  @Get('orders/summary')
  @BotRequirePermissions('orders:summary')
  ordersSummary(@Query('date') rawDate?: string) {
    const date = rawDate?.trim() || currentDateInTehran();

    if (parseDateOnlyUtc(date) === null) {
      throw new BadRequestException('date must be a valid YYYY-MM-DD date.');
    }

    return this.reports.getOrdersTodaySummary(date);
  }

  @Get('orders')
  @BotRequirePermissions('orders:read')
  ordersList(
    @Query('page') rawPage?: string,
    @Query('limit') rawLimit?: string,
    @Query('status') rawStatus?: string,
    @Query('from') rawFrom?: string,
    @Query('to') rawTo?: string,
  ) {
    const page = validatePage(rawPage, 1);
    const limit = validateLimit(rawLimit, 10, 20);

    let status: string | undefined;

    if (rawStatus !== undefined && rawStatus !== '') {
      const normalizedStatus = rawStatus.trim().toLowerCase();

      if (!ALLOWED_ORDER_STATUSES.has(normalizedStatus)) {
        throw new BadRequestException(
          `Invalid order status. Allowed: ${[...ALLOWED_ORDER_STATUSES].join(', ')}.`,
        );
      }

      status = normalizedStatus;
    }

    let from: string | undefined;
    let to: string | undefined;

    if (rawFrom || rawTo) {
      const validated = validateDateRange(rawFrom, rawTo);
      from = validated.from;
      to = validated.to;
    }

    return this.reports.listOrders({ page, limit, status, from, to });
  }

  @Get('orders/:orderNumber')
  @BotRequirePermissions('orders:read')
  async orderDetail(
    @Param('orderNumber') orderNumber: string,
    @Query('includeCustomer') rawIncludeCustomer: string | undefined,
    @Req() req: BotAuthorizedRequest,
  ) {
    if (!/^[\p{L}\p{N}-]{2,64}$/u.test(orderNumber)) {
      throw new BadRequestException('Invalid order number.');
    }

    const canViewCustomer = Boolean(
      req.botPermissions?.includes('orders:customer_pii'),
    );
    const includeCustomer =
      rawIncludeCustomer === 'true' || rawIncludeCustomer === '1';

    if (includeCustomer && !canViewCustomer) {
      throw new ForbiddenException(
        'برای نمایش این اطلاعات دسترسی لازم را ندارید.',
      );
    }

    const detail = await this.reports.getOrderDetail(orderNumber, {
      canViewCustomer,
      includeCustomer,
    });

    if (!detail) {
      return { orderNumber, notFound: true };
    }

    if (includeCustomer && canViewCustomer) {
      this.logger.log(
        `نمایش اطلاعات تحویل سفارش ${orderNumber} برای اپراتور مجاز (${req.botAuth?.baleUserId}).`,
      );
    }

    return detail;
  }

  /* ------------------------------ فروش و مشتری ------------------------------ */

  @Get('reports/sales')
  @BotRequirePermissions('sales:read')
  sales(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.getSalesSummary(validateDateRange(from, to));
  }

  @Get('reports/sales/export')
  @BotRequirePermissions('sales:export')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async salesExport(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() req: BotAuthorizedRequest,
    @Res() res: Response,
  ) {
    const result = await this.reports.exportSalesCsv(
      validateDateRange(from, to),
    );
    sendCsvOrJson(req, res, result);
  }

  @Get('reports/customers')
  @BotRequirePermissions('customers:read')
  customers(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.getCustomerSummary(validateDateRange(from, to));
  }

  /* ------------------------------ موجودی کالا ------------------------------ */

  @Get('inventory/summary')
  @BotRequirePermissions('inventory:read')
  inventorySummary() {
    return this.reports.getInventorySummary();
  }

  @Get('inventory')
  @BotRequirePermissions('inventory:read')
  inventoryList(
    @Query() fullQuery: Record<string, unknown>,
    @Query('category') rawCategory = 'low',
    @Query('query') rawQuery?: string,
    @Query('threshold') rawThreshold?: string,
    @Query('page') rawPage?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const allowedKeys = new Set([
      'category',
      'query',
      'threshold',
      'page',
      'limit',
    ]);
    for (const key of Object.keys(fullQuery ?? {})) {
      if (!allowedKeys.has(key)) {
        throw new BadRequestException(`Unknown query parameter: ${key}`);
      }
    }

    const category = rawCategory
      .trim()
      .toLowerCase() as InventoryCategoryFilter;

    if (!ALLOWED_INVENTORY_CATEGORIES.has(category)) {
      throw new BadRequestException(
        'category must be one of: out, low, in, all.',
      );
    }

    const page = validatePage(rawPage, 1);
    const limit = validateLimit(rawLimit, 15, 20);
    const threshold = validateOptionalThreshold(rawThreshold);
    const query = validateSearchQuery(rawQuery);

    return this.reports.listInventory({
      category,
      query,
      threshold,
      page,
      limit,
    });
  }

  @Get('inventory/export')
  @BotRequirePermissions('inventory:export')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async inventoryExport(
    @Query('category') rawCategory = 'all',
    @Query('query') rawQuery: string | undefined,
    @Query('threshold') rawThreshold: string | undefined,
    @Req() req: BotAuthorizedRequest,
    @Res() res: Response,
  ) {
    const category = rawCategory
      .trim()
      .toLowerCase() as InventoryCategoryFilter;

    if (!ALLOWED_INVENTORY_CATEGORIES.has(category)) {
      throw new BadRequestException(
        'category must be one of: out, low, in, all.',
      );
    }

    const threshold = validateOptionalThreshold(rawThreshold);
    const query = validateSearchQuery(rawQuery);
    const result = await this.reports.exportInventoryCsv({
      category,
      query,
      threshold,
    });
    sendCsvOrJson(req, res, result);
  }

  @Get('inventory/low-stock')
  @BotRequirePermissions('inventory:read')
  lowStock(@Query('threshold') rawThreshold = '3') {
    const threshold = validateOptionalThreshold(rawThreshold) ?? 3;

    return this.reports.getLowStock({ threshold });
  }

  /* ------------------------------ تنظیمات و نقش‌ها ------------------------------ */

  @Get('settings')
  @BotRequirePermissions('settings:read')
  getSettings() {
    return this.settingsService.getSettingsDto();
  }

  @Patch('settings')
  @BotRequirePermissions('settings:write')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  updateSettings(
    @Body() body: UpdateBotSettingsInput,
    @Req() req: BotAuthorizedRequest,
  ) {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Invalid settings payload.');
    }

    return this.settingsService.updateSettings(req.botAuth!.baleUserId!, body);
  }

  @Get('settings/operators')
  @BotRequirePermissions('roles:manage')
  async listOperators() {
    return {
      operators: await this.accessService.listOperators(),
    };
  }

  @Put('settings/operators/:baleUserId')
  @BotRequirePermissions('roles:manage')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  upsertOperator(
    @Param('baleUserId') baleUserId: string,
    @Body()
    body: {
      role?: string;
      label?: string | null;
      isActive?: boolean;
      receiveOrderAlerts?: boolean;
      receiveInventoryAlerts?: boolean;
      receiveHealthAlerts?: boolean;
    },
    @Req() req: BotAuthorizedRequest,
  ) {
    return this.accessService.upsertOperator({
      actorBaleId: req.botAuth!.baleUserId!,
      targetBaleUserId: baleUserId,
      role: body?.role,
      label: body?.label,
      isActive: body?.isActive,
      receiveOrderAlerts: body?.receiveOrderAlerts,
      receiveInventoryAlerts: body?.receiveInventoryAlerts,
      receiveHealthAlerts: body?.receiveHealthAlerts,
    });
  }

  @Delete('settings/operators/:baleUserId')
  @BotRequirePermissions('roles:manage')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  deactivateOperator(
    @Param('baleUserId') baleUserId: string,
    @Req() req: BotAuthorizedRequest,
  ) {
    return this.accessService.deactivateOperator(
      req.botAuth!.baleUserId!,
      baleUserId,
    );
  }

  /* ---------------------------- صف اعلان‌ها (Outbox) ---------------------------- */

  @Post('events/lease')
  @HttpCode(HttpStatus.OK)
  @BotSystemWorkerOnly()
  async leaseEvents(@Body() body?: { workerId?: string; limit?: number }) {
    const limit = Number(body?.limit ?? 10);

    if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new BadRequestException(
        'limit must be an integer between 1 and 25.',
      );
    }

    const events = await this.eventsService.leaseReadyEvents({
      workerId: typeof body?.workerId === 'string' ? body.workerId : 'bale-bot',
      limit,
    });

    const owners = await this.accessService.resolveAuthorizedRecipients(
      'sync_health' as never,
    );

    return {
      events,
      healthRecipients: owners,
      polledAt: new Date().toISOString(),
    };
  }

  @Post('events/ack')
  @HttpCode(HttpStatus.OK)
  @BotSystemWorkerOnly()
  ackEvents(@Body() body?: { results?: AckEventItemInput[] }) {
    return this.eventsService.acknowledgeEvents(body?.results ?? []);
  }

  @Get('events/summary')
  @BotRequirePermissions('alerts:read')
  eventsSummary() {
    return this.eventsService.getOutboxSummary();
  }

  @Get('events/recent')
  @BotRequirePermissions('alerts:read')
  eventsRecent(
    @Query('page') rawPage?: string,
    @Query('limit') rawLimit?: string,
    @Query('status') rawStatus?: string,
  ) {
    const page = validatePage(rawPage, 1);
    const limit = validateLimit(rawLimit, 10, 20);
    let status: BotOutboxStatus | undefined;

    if (rawStatus !== undefined && rawStatus !== '') {
      const normalized = rawStatus.trim().toLowerCase();

      if (!ALLOWED_OUTBOX_STATUSES.has(normalized)) {
        throw new BadRequestException(
          `Invalid outbox status. Allowed: ${[...ALLOWED_OUTBOX_STATUSES].join(', ')}.`,
        );
      }

      status = normalized as BotOutboxStatus;
    }

    return this.eventsService.listOutboxEvents({ page, limit, status });
  }

  @Post('events/retry-failed')
  @HttpCode(HttpStatus.OK)
  @BotRequirePermissions('alerts:manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  retryFailed(
    @Body() body: { eventId?: string } | undefined,
    @Req() req: BotAuthorizedRequest,
  ) {
    const eventId =
      typeof body?.eventId === 'string' && body.eventId.trim()
        ? body.eventId.trim()
        : undefined;

    if (eventId && !/^[\w-]{8,64}$/.test(eventId)) {
      throw new BadRequestException('Invalid eventId.');
    }

    return this.eventsService.retryFailedEvents(
      req.botAuth!.baleUserId!,
      eventId,
    );
  }

  /* ------------------------------ سلامت سرویس ------------------------------ */

  @Get('system/health')
  @BotSystemOrPermissions('alerts:read')
  async systemHealth(): Promise<BotSystemHealthDto> {
    let dbState: 'up' | 'down' = 'up';

    try {
      if (typeof this.dataSource?.query === 'function') {
        await this.dataSource.query('SELECT 1');
      }
    } catch {
      dbState = 'down';
    }

    const [sync, outbox] = await Promise.all([
      this.settingsService.getSyncHealthDto(),
      this.eventsService.getOutboxSummary(),
    ]);

    const ok =
      dbState === 'up' &&
      sync.status !== 'failed' &&
      !sync.isStale &&
      outbox.failed === 0;

    return {
      ok,
      database: dbState,
      sync,
      outbox,
      checkedAt: new Date().toISOString(),
      timezone: BOT_REPORTS_TIMEZONE,
    };
  }
}
