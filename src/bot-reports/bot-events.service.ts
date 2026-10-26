import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Order, OrderStatus } from 'src/order/entities/order.entity';
import { DataSource, EntityManager, In, LessThan, Repository } from 'typeorm';

import { BotAccessService } from './bot-access.service';
import {
  BOT_REPORTS_CURRENCY,
  BotLeasedEventDto,
  BotOutboxEventViewDto,
  BotOutboxSummaryDto,
} from './bot-reports.contract';
import { BotSettingsService } from './bot-settings.service';
import { toTehranWallClockIso } from './bot-time.util';
import {
  BotInventoryAlertState,
  VariantAlertState,
} from './entities/bot-inventory-alert-state.entity';
import {
  BotEventType,
  BotNotificationCategory,
  BotOutboxEvent,
  BotOutboxStatus,
} from './entities/bot-outbox-event.entity';
import {
  BotSetting,
  BotSyncStatsSnapshot,
} from './entities/bot-setting.entity';

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'password',
  'nationalcode',
  'phone',
  'mobile',
  'email',
  'address',
  'postalcode',
  'gatewayresponse',
  'ip',
  'useragent',
  'token',
  'secret',
  'authorization',
]);

/** زمان اجارهٔ هر رویداد به سرویس ربات (ثانیه) */
const DEFAULT_LEASE_DURATION_SECONDS = 60;

/** زمان‌های عقب‌نشینی نمایی (Exponential Backoff) بر حسب ثانیه */
const RETRY_BACKOFF_SECONDS = [15, 30, 60, 120, 300, 900, 1800, 3600];

export interface VariantStockChangeInput {
  variantId: number;
  productTitle: string;
  variantLabel?: string | null;
  sku?: string | null;
  oldStock: number;
  newStock: number;
  syncedAt?: string | Date | null;
}

export interface EnqueueOutboxInput {
  idempotencyKey: string;
  eventType: BotEventType;
  category: BotNotificationCategory;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

export interface AckEventItemInput {
  eventId: string;
  leaseToken: string;
  outcome: 'delivered' | 'retry' | 'failed';
  error?: string;
}

export function sanitizeOutboxPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload ?? {})) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = sanitizeOutboxPayload(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }

  return clean;
}

export function sanitizeOperationalError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error';

  return raw
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/(token|secret|password|apikey)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, 'https://[REDACTED]@')
    .slice(0, 240);
}

export function computeRetryBackoffMs(attempts: number): number {
  const index = Math.max(
    0,
    Math.min(RETRY_BACKOFF_SECONDS.length - 1, attempts - 1),
  );

  return RETRY_BACKOFF_SECONDS[index] * 1000;
}

export function classifyStockState(
  stock: number,
  threshold: number,
): VariantAlertState {
  if (stock <= 0) {
    return 'out';
  }

  if (stock <= threshold) {
    return 'low';
  }

  return 'healthy';
}

/**
 * سرویس زیرساختی ثبت، زمان‌بندی، اجاره (Lease)، تأیید (Ack)، بازیابی و پاک‌سازی
 * رویدادهای مدیریتی فروشگاه برای ربات بله (Transactional Outbox Pattern).
 */
@Injectable()
export class BotEventsService {
  private readonly logger = new Logger(BotEventsService.name);

  constructor(
    @InjectRepository(BotOutboxEvent)
    private readonly outboxRepo: Repository<BotOutboxEvent>,
    @InjectRepository(BotInventoryAlertState)
    private readonly alertStateRepo: Repository<BotInventoryAlertState>,
    @InjectRepository(BotSetting)
    private readonly settingRepo: Repository<BotSetting>,
    private readonly settingsService: BotSettingsService,
    private readonly accessService: BotAccessService,
    private readonly dataSource: DataSource,
  ) {}

  /* ====================================================================== */
  /* ۱. ثبت اتمیک در Outbox (داخل یا خارج تراکنش موجود)                     */
  /* ====================================================================== */

  async enqueueInTransaction(
    manager: EntityManager,
    input: EnqueueOutboxInput,
  ): Promise<BotOutboxEvent | null> {
    const repo = manager.getRepository(BotOutboxEvent);
    const key = input.idempotencyKey.slice(0, 191);

    const existing = await repo.findOne({ where: { idempotencyKey: key } });

    if (existing) {
      return existing;
    }

    const entity = repo.create({
      eventId: randomUUID(),
      idempotencyKey: key,
      eventType: input.eventType,
      category: input.category,
      status: BotOutboxStatus.PENDING,
      payload: sanitizeOutboxPayload(input.payload),
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 8,
      availableAt: new Date(),
      leaseOwner: null,
      leaseToken: null,
      leasedUntil: null,
      deliveredAt: null,
      lastError: null,
    });

    try {
      return await repo.save(entity);
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        return repo.findOne({ where: { idempotencyKey: key } });
      }

      throw error;
    }
  }

  async enqueue(input: EnqueueOutboxInput): Promise<BotOutboxEvent | null> {
    if (typeof this.outboxRepo?.findOne !== 'function') {
      return null;
    }

    const key = input.idempotencyKey.slice(0, 191);
    const existing = await this.outboxRepo.findOne({
      where: { idempotencyKey: key },
    });

    if (existing) {
      return existing;
    }

    const entity = this.outboxRepo.create({
      eventId: randomUUID(),
      idempotencyKey: key,
      eventType: input.eventType,
      category: input.category,
      status: BotOutboxStatus.PENDING,
      payload: sanitizeOutboxPayload(input.payload),
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 8,
      availableAt: new Date(),
      leaseOwner: null,
      leaseToken: null,
      leasedUntil: null,
      deliveredAt: null,
      lastError: null,
    });

    try {
      return await this.outboxRepo.save(entity);
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        return this.outboxRepo.findOne({ where: { idempotencyKey: key } });
      }

      this.logger.error(
        `ثبت رویداد در outbox ناموفق بود (${input.eventType}): ${sanitizeOperationalError(error)}`,
      );
      return null;
    }
  }

  /* ====================================================================== */
  /* ۲. رویدادهای چرخهٔ حیات سفارش                                          */
  /* ====================================================================== */

  async recordOrderCreatedInTransaction(
    manager: EntityManager,
    order: Pick<
      Order,
      'id' | 'orderNumber' | 'status' | 'finalPrice' | 'items' | 'createdAt'
    >,
  ): Promise<void> {
    const itemsCount = (order.items ?? []).reduce(
      (sum, item) => sum + (Number(item.quantity) || 0),
      0,
    );

    await this.enqueueInTransaction(manager, {
      idempotencyKey: `order:${order.id}:created`,
      eventType: BotEventType.ORDER_CREATED,
      category: BotNotificationCategory.ORDER_CREATED,
      payload: {
        orderNumber: order.orderNumber,
        status: order.status,
        finalPrice: Number(order.finalPrice) || 0,
        currency: BOT_REPORTS_CURRENCY,
        itemsCount,
        occurredAt:
          toTehranWallClockIso(order.createdAt) ?? new Date().toISOString(),
      },
    });
  }

  async recordOrderPaidInTransaction(
    manager: EntityManager,
    order: Pick<
      Order,
      'id' | 'orderNumber' | 'status' | 'finalPrice' | 'items' | 'updatedAt'
    >,
  ): Promise<void> {
    const itemsCount = (order.items ?? []).reduce(
      (sum, item) => sum + (Number(item.quantity) || 0),
      0,
    );

    await this.enqueueInTransaction(manager, {
      idempotencyKey: `order:${order.id}:paid`,
      eventType: BotEventType.ORDER_PAID,
      category: BotNotificationCategory.ORDER_PAID,
      payload: {
        orderNumber: order.orderNumber,
        status: OrderStatus.PAID,
        finalPrice: Number(order.finalPrice) || 0,
        currency: BOT_REPORTS_CURRENCY,
        itemsCount,
        occurredAt:
          toTehranWallClockIso(order.updatedAt) ?? new Date().toISOString(),
      },
    });
  }

  async recordOrderStatusTransitionInTransaction(
    manager: EntityManager,
    order: Pick<Order, 'id' | 'orderNumber' | 'status' | 'finalPrice'>,
    previousStatus: OrderStatus,
    source: 'customer' | 'admin' | 'payment_failed',
  ): Promise<void> {
    if (previousStatus === order.status) {
      return;
    }

    const isCancelled = order.status === OrderStatus.CANCELLED;
    const outboxRepo = manager.getRepository(BotOutboxEvent);

    // شمارش تعداد transitionهای قبلی همین سفارش تا اگر سفارش قانونی چند مرحله جلو رفت
    // کلید یکتای مرحلهٔ جدید ساخته شود، اما اجرای مجدد همان تغییر داخل یک تراکنش تکراری نسازد.
    const priorTransitionsCount = await outboxRepo
      .createQueryBuilder('evt')
      .where('evt.idempotencyKey LIKE :prefix', {
        prefix: `order:${order.id}:transition:%`,
      })
      .getCount();

    const seq = priorTransitionsCount + 1;

    await this.enqueueInTransaction(manager, {
      idempotencyKey: `order:${order.id}:transition:${seq}:${previousStatus}->${order.status}`,
      eventType: isCancelled
        ? BotEventType.ORDER_CANCELLED
        : BotEventType.ORDER_STATUS_CHANGED,
      category: isCancelled
        ? BotNotificationCategory.ORDER_CANCELLED
        : BotNotificationCategory.ORDER_STATUS,
      payload: {
        orderNumber: order.orderNumber,
        previousStatus,
        status: order.status,
        source,
        finalPrice: Number(order.finalPrice) || 0,
        currency: BOT_REPORTS_CURRENCY,
        occurredAt: new Date().toISOString(),
      },
    });
  }

  async recordOrderWalletRefund(input: {
    orderId: number;
    orderNumber: string;
    refundedAmount: number;
    transactionKey: string;
  }): Promise<void> {
    await this.enqueue({
      idempotencyKey: `order:${input.orderId}:refund:${input.transactionKey}`,
      eventType: BotEventType.ORDER_REFUNDED,
      category: BotNotificationCategory.ORDER_CANCELLED,
      payload: {
        orderNumber: input.orderNumber,
        refundedAmount: Number(input.refundedAmount) || 0,
        currency: BOT_REPORTS_CURRENCY,
        occurredAt: new Date().toISOString(),
      },
    });
  }

  /* ====================================================================== */
  /* ۳. تشخیص Transition معنادار موجودی واریانت‌ها                          */
  /* ====================================================================== */

  async evaluateVariantStockTransitions(
    changes: VariantStockChangeInput[],
    manager?: EntityManager,
  ): Promise<number> {
    if (!changes.length) {
      return 0;
    }

    const setting = await this.settingsService.getOrCreateEntity();
    const threshold = setting.lowStockThreshold;
    const reminderHours = setting.inventoryReminderHours;
    const syncHealth = await this.settingsService.getSyncHealthDto();
    const defaultSyncedAt =
      syncHealth.lastSucceededAt ?? syncHealth.fallbackVariantUpdatedAt;

    const stateRepo = manager
      ? manager.getRepository(BotInventoryAlertState)
      : this.alertStateRepo;

    if (typeof stateRepo?.find !== 'function') {
      return 0;
    }

    const variantIds = [...new Set(changes.map(item => item.variantId))];
    const existingRows = await stateRepo.find({
      where: { variantId: In(variantIds) },
    });
    const stateMap = new Map<number, BotInventoryAlertState>(
      existingRows.map(row => [row.variantId, row]),
    );

    let emitted = 0;
    const now = new Date();

    for (const change of changes) {
      const oldStock = Math.max(0, Math.trunc(Number(change.oldStock) || 0));
      const newStock = Math.max(0, Math.trunc(Number(change.newStock) || 0));

      const existing = stateMap.get(change.variantId);
      const prevState: VariantAlertState = existing
        ? existing.state
        : classifyStockState(oldStock, threshold);
      const nextState = classifyStockState(newStock, threshold);

      let episode = existing
        ? existing.episode
        : prevState === 'healthy'
          ? 0
          : 1;
      let shouldAlert = false;
      let idempotencyKey = '';

      if (nextState === 'healthy') {
        // بازگشت موجودی به بالای آستانه: وضعیت سالم ثبت می‌شود تا افت بعدی episode تازه بگیرد.
        shouldAlert = false;
      } else if (prevState === 'healthy') {
        // ورود تازه از وضعیت سالم به کم‌موجود یا ناموجود
        episode += 1;
        shouldAlert = true;
        idempotencyKey = `inv:v:${change.variantId}:ep:${episode}:${nextState}`;
      } else if (prevState === 'low' && nextState === 'out') {
        // افت از کم‌موجود به صفر (ناموجودشدن کامل)
        if (episode <= 0) episode = 1;
        shouldAlert = true;
        idempotencyKey = `inv:v:${change.variantId}:ep:${episode}:out`;
      } else if (
        prevState === nextState &&
        reminderHours > 0 &&
        existing?.lastAlertedAt &&
        now.getTime() - existing.lastAlertedAt.getTime() >=
          reminderHours * 3_600_000
      ) {
        const reminderBucket = Math.floor(
          now.getTime() / (reminderHours * 3_600_000),
        );
        shouldAlert = true;
        idempotencyKey = `inv:v:${change.variantId}:ep:${episode}:${nextState}:rem:${reminderBucket}`;
      }

      const nextRow =
        existing ?? stateRepo.create({ variantId: change.variantId });
      nextRow.state = nextState;
      nextRow.episode = episode;
      nextRow.lastStock = newStock;
      nextRow.lastThreshold = threshold;
      if (shouldAlert) {
        nextRow.lastAlertedAt = now;
      }

      await stateRepo.save(nextRow);
      stateMap.set(change.variantId, nextRow);

      if (shouldAlert) {
        const eventInput: EnqueueOutboxInput = {
          idempotencyKey,
          eventType:
            nextState === 'out'
              ? BotEventType.INVENTORY_OUT_OF_STOCK
              : BotEventType.INVENTORY_LOW_STOCK,
          category: BotNotificationCategory.INVENTORY,
          payload: {
            variantId: change.variantId,
            productName: change.productTitle,
            variant: change.variantLabel ?? null,
            sku: change.sku ?? null,
            previousStock: oldStock,
            currentStock: newStock,
            threshold,
            syncedAt:
              toTehranWallClockIso(change.syncedAt) ?? defaultSyncedAt ?? null,
            occurredAt: now.toISOString(),
          },
        };

        if (manager) {
          await this.enqueueInTransaction(manager, eventInput);
        } else {
          await this.enqueue(eventInput);
        }

        emitted += 1;
      }
    }

    return emitted;
  }

  /* ====================================================================== */
  /* ۴. ثبت نتیجهٔ واقعی همگام‌سازی راهکاران و تشخیص خطا/بازیابی/قدیمی‌بودن  */
  /* ====================================================================== */

  async recordSyncStarted(): Promise<void> {
    if (typeof this.settingRepo?.save !== 'function') {
      return;
    }

    const setting = await this.settingsService.getOrCreateEntity();
    setting.lastSyncStartedAt = new Date();
    setting.lastSyncStatus = 'running';
    await this.settingRepo.save(setting);
  }

  async recordSyncSucceeded(stats: BotSyncStatsSnapshot): Promise<void> {
    if (typeof this.settingRepo?.save !== 'function') {
      return;
    }

    const setting = await this.settingsService.getOrCreateEntity();
    const now = new Date();
    const hadOpenIncident = Boolean(setting.syncIncidentOpen);
    const incidentNumber = setting.syncIncidentCount;

    setting.lastSyncSucceededAt = now;
    setting.lastSyncStatus = stats.failed > 0 ? 'partial_error' : 'ok';
    setting.lastSyncError =
      stats.failed > 0
        ? `${stats.failed} مورد در دریافت/ذخیرهٔ موجودی خطا داشت.`
        : null;
    setting.lastSyncStats = stats;
    setting.syncIncidentOpen = false;
    setting.lastStaleAlertKey = null;

    await this.settingRepo.save(setting);

    if (hadOpenIncident) {
      await this.enqueue({
        idempotencyKey: `sync:rahkaran:recovered:${incidentNumber}`,
        eventType: BotEventType.SYNC_RECOVERED,
        category: BotNotificationCategory.SYNC_HEALTH,
        payload: {
          jobName: 'rahkaran-products-sync',
          matched: stats.matched,
          updated: stats.updated,
          failed: stats.failed,
          durationSeconds: stats.durationSeconds,
          occurredAt: toTehranWallClockIso(now) ?? now.toISOString(),
        },
      });
    }
  }

  async recordSyncFailed(
    error: unknown,
    partialStats?: Partial<BotSyncStatsSnapshot>,
  ): Promise<void> {
    if (typeof this.settingRepo?.save !== 'function') {
      return;
    }

    const setting = await this.settingsService.getOrCreateEntity();
    const now = new Date();
    const cleanError = sanitizeOperationalError(error);
    const shouldEmitNewIncident = !setting.syncIncidentOpen;

    if (shouldEmitNewIncident) {
      setting.syncIncidentCount = (setting.syncIncidentCount || 0) + 1;
      setting.syncIncidentOpen = true;
    }

    setting.lastSyncFailedAt = now;
    setting.lastSyncStatus = 'failed';
    setting.lastSyncError = cleanError;

    if (partialStats) {
      setting.lastSyncStats = {
        received: partialStats.received ?? 0,
        matched: partialStats.matched ?? 0,
        updated: partialStats.updated ?? 0,
        unchanged: partialStats.unchanged ?? 0,
        skipped: partialStats.skipped ?? 0,
        failed: partialStats.failed ?? 0,
        durationSeconds: partialStats.durationSeconds ?? 0,
      };
    }

    await this.settingRepo.save(setting);

    if (shouldEmitNewIncident) {
      await this.enqueue({
        idempotencyKey: `sync:rahkaran:failed:${setting.syncIncidentCount}`,
        eventType: BotEventType.SYNC_FAILED,
        category: BotNotificationCategory.SYNC_HEALTH,
        payload: {
          jobName: 'rahkaran-products-sync',
          errorSummary: cleanError,
          updatedBeforeFailure: partialStats?.updated ?? 0,
          failedCount: partialStats?.failed ?? 0,
          occurredAt: toTehranWallClockIso(now) ?? now.toISOString(),
        },
      });
    }
  }

  async checkStaleSyncAndNotify(): Promise<boolean> {
    const setting = await this.settingsService.getOrCreateEntity();
    const fallback = await this.settingsService.getMaxVariantUpdatedAt();
    const health = this.settingsService.buildSyncHealthDto(setting, fallback);

    if (!health.isStale) {
      return false;
    }

    const marker =
      health.lastSucceededAt ?? health.fallbackVariantUpdatedAt ?? 'never';

    if (setting.lastStaleAlertKey === marker) {
      return false;
    }

    setting.lastStaleAlertKey = marker;
    await this.settingRepo.save(setting);

    await this.enqueue({
      idempotencyKey: `sync:rahkaran:stale:${marker}`,
      eventType: BotEventType.SYNC_STALE,
      category: BotNotificationCategory.SYNC_HEALTH,
      payload: {
        lastSyncedAt: marker === 'never' ? null : marker,
        staleThresholdHours: health.staleThresholdHours,
        occurredAt: new Date().toISOString(),
      },
    });

    return true;
  }

  /* ====================================================================== */
  /* ۵. Lease، Ack، صف خطاها، بازیابی و پاک‌سازی دوره‌ای (Retention)        */
  /* ====================================================================== */

  async leaseReadyEvents(input: {
    workerId: string;
    limit: number;
  }): Promise<BotLeasedEventDto[]> {
    const safeLimit = Math.max(1, Math.min(25, Math.trunc(input.limit) || 10));
    const workerId = (input.workerId || 'bale-bot').slice(0, 64);
    const now = new Date();

    await this.reclaimExpiredLeases(now);

    const candidates = await this.outboxRepo
      .createQueryBuilder('evt')
      .where('evt.status = :status', { status: BotOutboxStatus.PENDING })
      .andWhere('evt.availableAt <= :now', { now })
      .orderBy('evt.id', 'ASC')
      .take(safeLimit)
      .getMany();

    if (!candidates.length) {
      return [];
    }

    const leasedDtos: BotLeasedEventDto[] = [];

    for (const evt of candidates) {
      const enabled = await this.settingsService.isCategoryEnabled(
        evt.category,
      );

      if (!enabled) {
        evt.status = BotOutboxStatus.SKIPPED;
        evt.lastError = 'این دسته اعلان در تنظیمات غیرفعال شده است.';
        await this.outboxRepo.save(evt);
        continue;
      }

      const recipients = await this.accessService.resolveAuthorizedRecipients(
        evt.category,
      );

      if (recipients.length === 0) {
        evt.status = BotOutboxStatus.SKIPPED;
        evt.lastError = 'گیرندهٔ مجازی برای این دسته اعلان فعال نیست.';
        await this.outboxRepo.save(evt);
        continue;
      }

      const leaseToken = randomUUID();
      const leasedUntil = new Date(
        now.getTime() + DEFAULT_LEASE_DURATION_SECONDS * 1000,
      );

      // آپدیت شرطی روی status=PENDING تا اگر هم‌زمان فرایند دیگری آن را گرفته بود، تداخل رخ ندهد
      const updateResult = await this.outboxRepo
        .createQueryBuilder()
        .update(BotOutboxEvent)
        .set({
          status: BotOutboxStatus.LEASED,
          leaseOwner: workerId,
          leaseToken,
          leasedUntil,
          attempts: () => 'attempts + 1',
        })
        .where('id = :id AND status = :pending', {
          id: evt.id,
          pending: BotOutboxStatus.PENDING,
        })
        .execute();

      if ((updateResult.affected ?? 0) === 0) {
        continue;
      }

      leasedDtos.push({
        eventId: evt.eventId,
        eventType: evt.eventType,
        category: evt.category,
        payload: sanitizeOutboxPayload(evt.payload),
        recipients,
        leaseToken,
        leasedUntil: leasedUntil.toISOString(),
        attempts: evt.attempts + 1,
        createdAt:
          toTehranWallClockIso(evt.createdAt) ?? evt.createdAt.toISOString(),
      });
    }

    return leasedDtos;
  }

  async acknowledgeEvents(results: AckEventItemInput[]): Promise<{
    processed: number;
    delivered: number;
    retried: number;
    failed: number;
  }> {
    if (!Array.isArray(results) || results.length > 50) {
      throw new BadRequestException(
        'results must be an array of up to 50 acknowledgement items.',
      );
    }

    let processed = 0;
    let delivered = 0;
    let retried = 0;
    let failed = 0;
    const now = new Date();

    for (const item of results) {
      if (!item?.eventId || !item?.leaseToken) {
        continue;
      }

      const evt = await this.outboxRepo.findOne({
        where: { eventId: String(item.eventId) },
      });

      if (!evt) {
        continue;
      }

      // Idempotent ack: اگر قبلاً تحویل ثبت شده باشد، دوباره موفق حساب می‌شود
      if (evt.status === BotOutboxStatus.DELIVERED) {
        processed += 1;
        delivered += 1;
        continue;
      }

      if (
        evt.status !== BotOutboxStatus.LEASED ||
        evt.leaseToken !== item.leaseToken
      ) {
        continue;
      }

      processed += 1;

      if (item.outcome === 'delivered') {
        evt.status = BotOutboxStatus.DELIVERED;
        evt.deliveredAt = now;
        evt.leaseOwner = null;
        evt.leaseToken = null;
        evt.leasedUntil = null;
        evt.lastError = null;
        await this.outboxRepo.save(evt);
        delivered += 1;
        continue;
      }

      const cleanErr = item.error
        ? sanitizeOperationalError(item.error)
        : 'خطا در تحویل پیام به بله.';

      if (item.outcome === 'failed' || evt.attempts >= evt.maxAttempts) {
        evt.status = BotOutboxStatus.FAILED;
        evt.leaseOwner = null;
        evt.leaseToken = null;
        evt.leasedUntil = null;
        evt.lastError = cleanErr;
        await this.outboxRepo.save(evt);
        failed += 1;
      } else {
        const delayMs = computeRetryBackoffMs(evt.attempts);
        evt.status = BotOutboxStatus.PENDING;
        evt.availableAt = new Date(now.getTime() + delayMs);
        evt.leaseOwner = null;
        evt.leaseToken = null;
        evt.leasedUntil = null;
        evt.lastError = cleanErr;
        await this.outboxRepo.save(evt);
        retried += 1;
      }
    }

    return { processed, delivered, retried, failed };
  }

  async getOutboxSummary(): Promise<BotOutboxSummaryDto> {
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 3_600_000);

    const [pending, leased, failed, deliveredLast24h, skippedLast24h] =
      await Promise.all([
        this.outboxRepo.count({ where: { status: BotOutboxStatus.PENDING } }),
        this.outboxRepo.count({ where: { status: BotOutboxStatus.LEASED } }),
        this.outboxRepo.count({ where: { status: BotOutboxStatus.FAILED } }),
        this.outboxRepo
          .createQueryBuilder('evt')
          .where('evt.status = :status', {
            status: BotOutboxStatus.DELIVERED,
          })
          .andWhere('evt.deliveredAt >= :since', { since: since24h })
          .getCount(),
        this.outboxRepo
          .createQueryBuilder('evt')
          .where('evt.status = :status', {
            status: BotOutboxStatus.SKIPPED,
          })
          .andWhere('evt.updatedAt >= :since', { since: since24h })
          .getCount(),
      ]);

    const oldestPending = await this.outboxRepo.findOne({
      where: { status: BotOutboxStatus.PENDING },
      order: { id: 'ASC' },
    });

    return {
      pending,
      leased,
      deliveredLast24h,
      failed,
      skippedLast24h,
      oldestPendingAt: toTehranWallClockIso(oldestPending?.createdAt),
    };
  }

  async listOutboxEvents(input: {
    page: number;
    limit: number;
    status?: BotOutboxStatus;
  }): Promise<{
    items: BotOutboxEventViewDto[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const page = Math.max(1, Math.trunc(input.page) || 1);
    const limit = Math.max(1, Math.min(20, Math.trunc(input.limit) || 10));

    const qb = this.outboxRepo
      .createQueryBuilder('evt')
      .orderBy('evt.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (input.status) {
      qb.where('evt.status = :status', { status: input.status });
    }

    const [rows, total] = await qb.getManyAndCount();

    return {
      items: rows.map(row => ({
        eventId: row.eventId,
        eventType: row.eventType,
        category: row.category,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        lastError: row.lastError ?? null,
        payload: sanitizeOutboxPayload(row.payload),
        createdAt:
          toTehranWallClockIso(row.createdAt) ?? row.createdAt.toISOString(),
        deliveredAt: toTehranWallClockIso(row.deliveredAt),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      },
    };
  }

  async retryFailedEvents(
    actorBaleId: string,
    eventId?: string,
  ): Promise<{ requeued: number }> {
    const now = new Date();
    const qb = this.outboxRepo
      .createQueryBuilder()
      .update(BotOutboxEvent)
      .set({
        status: BotOutboxStatus.PENDING,
        attempts: 0,
        availableAt: now,
        leaseOwner: null,
        leaseToken: null,
        leasedUntil: null,
        lastError: null,
      })
      .where('status = :failed', { failed: BotOutboxStatus.FAILED });

    if (eventId) {
      qb.andWhere('event_id = :eventId', { eventId });
    }

    const res = await qb.execute();
    const requeued = res.affected ?? 0;

    this.logger.log(
      `بازیابی رویدادهای ناموفق outbox توسط مالک (${actorBaleId}): تعداد=${requeued}`,
    );

    return { requeued };
  }

  async purgeExpiredEvents(
    deliveredRetentionDays = 30,
    failedRetentionDays = 90,
  ): Promise<{ deletedCount: number }> {
    const now = Date.now();
    const deliveredCutoff = new Date(now - deliveredRetentionDays * 86_400_000);
    const failedCutoff = new Date(now - failedRetentionDays * 86_400_000);

    const deliveredResult = await this.outboxRepo.delete({
      status: In([BotOutboxStatus.DELIVERED, BotOutboxStatus.SKIPPED]),
      createdAt: LessThan(deliveredCutoff),
    });

    const failedResult = await this.outboxRepo.delete({
      status: BotOutboxStatus.FAILED,
      createdAt: LessThan(failedCutoff),
    });

    const deletedCount =
      (deliveredResult.affected ?? 0) + (failedResult.affected ?? 0);

    if (deletedCount > 0) {
      this.logger.log(
        `پاک‌سازی دوره‌ای جدول bot_outbox_events انجام شد: ${deletedCount} رکورد قدیمی حذف شد.`,
      );
    }

    return { deletedCount };
  }

  private async reclaimExpiredLeases(now: Date): Promise<void> {
    const expired = await this.outboxRepo
      .createQueryBuilder('evt')
      .where('evt.status = :leased', { leased: BotOutboxStatus.LEASED })
      .andWhere('evt.leasedUntil IS NOT NULL AND evt.leasedUntil <= :now', {
        now,
      })
      .take(100)
      .getMany();

    for (const evt of expired) {
      if (evt.attempts >= evt.maxAttempts) {
        evt.status = BotOutboxStatus.FAILED;
        evt.lastError = evt.lastError ?? 'انقضای مهلت ارسال پس از حداکثر تلاش.';
      } else {
        evt.status = BotOutboxStatus.PENDING;
        evt.availableAt = new Date(
          now.getTime() + computeRetryBackoffMs(evt.attempts),
        );
      }

      evt.leaseOwner = null;
      evt.leaseToken = null;
      evt.leasedUntil = null;

      await this.outboxRepo.save(evt);
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    const anyError = error as {
      code?: string;
      errno?: number;
      message?: string;
    };

    return (
      anyError?.code === 'ER_DUP_ENTRY' ||
      anyError?.errno === 1062 ||
      (typeof anyError?.message === 'string' &&
        (anyError.message.includes('Duplicate entry') ||
          anyError.message.includes('UNIQUE constraint failed')))
    );
  }
}
