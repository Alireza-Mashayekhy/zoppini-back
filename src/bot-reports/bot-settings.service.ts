import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Variant } from 'src/products/entities/variant.entity';
import { Repository } from 'typeorm';

import { BotSettingsDto, InventorySyncHealthDto } from './bot-reports.contract';
import { toTehranWallClockIso } from './bot-time.util';
import { BotNotificationCategory } from './entities/bot-outbox-event.entity';
import { BotSetting } from './entities/bot-setting.entity';

export const DEFAULT_LOW_STOCK_THRESHOLD = 3;
export const DEFAULT_STALE_SYNC_HOURS = 30;

export interface UpdateBotSettingsInput {
  lowStockThreshold?: number;
  notifyOrderCreated?: boolean;
  notifyOrderPaid?: boolean;
  notifyOrderCancelled?: boolean;
  notifyOrderStatusChanged?: boolean;
  notifyInventoryAlerts?: boolean;
  notifySyncAndHealth?: boolean;
  inventoryReminderHours?: number;
  staleSyncThresholdHours?: number;
}

@Injectable()
export class BotSettingsService {
  private readonly logger = new Logger(BotSettingsService.name);

  constructor(
    @InjectRepository(BotSetting)
    private readonly settingRepo: Repository<BotSetting>,
    @InjectRepository(Variant)
    private readonly variantRepo: Repository<Variant>,
  ) {}

  async getOrCreateEntity(): Promise<BotSetting> {
    if (typeof this.settingRepo?.findOne !== 'function') {
      return this.buildDefaultSetting();
    }

    let setting = await this.settingRepo.findOne({ where: { id: 1 } });

    if (!setting) {
      setting = this.buildDefaultSetting();

      if (typeof this.settingRepo?.save === 'function') {
        try {
          setting = await this.settingRepo.save(setting);
        } catch {
          const existing = await this.settingRepo.findOne({
            where: { id: 1 },
          });

          if (existing) {
            setting = existing;
          }
        }
      }
    }

    return setting;
  }

  async getLowStockThreshold(): Promise<number> {
    const setting = await this.getOrCreateEntity();

    return Number.isInteger(setting.lowStockThreshold) &&
      setting.lowStockThreshold >= 0
      ? setting.lowStockThreshold
      : DEFAULT_LOW_STOCK_THRESHOLD;
  }

  async isCategoryEnabled(category: BotNotificationCategory): Promise<boolean> {
    const setting = await this.getOrCreateEntity();

    switch (category) {
      case BotNotificationCategory.ORDER_CREATED:
        return Boolean(setting.notifyOrderCreated);
      case BotNotificationCategory.ORDER_PAID:
        return Boolean(setting.notifyOrderPaid);
      case BotNotificationCategory.ORDER_CANCELLED:
        return Boolean(setting.notifyOrderCancelled);
      case BotNotificationCategory.ORDER_STATUS:
        return Boolean(setting.notifyOrderStatusChanged);
      case BotNotificationCategory.INVENTORY:
        return Boolean(setting.notifyInventoryAlerts);
      case BotNotificationCategory.SYNC_HEALTH:
        return Boolean(setting.notifySyncAndHealth);
      default:
        return true;
    }
  }

  async getSettingsDto(): Promise<BotSettingsDto> {
    const setting = await this.getOrCreateEntity();
    const fallbackVariantUpdatedAt = await this.getMaxVariantUpdatedAt();
    const sync = this.buildSyncHealthDto(setting, fallbackVariantUpdatedAt);

    return {
      lowStockThreshold: setting.lowStockThreshold,
      notifyOrderCreated: Boolean(setting.notifyOrderCreated),
      notifyOrderPaid: Boolean(setting.notifyOrderPaid),
      notifyOrderCancelled: Boolean(setting.notifyOrderCancelled),
      notifyOrderStatusChanged: Boolean(setting.notifyOrderStatusChanged),
      notifyInventoryAlerts: Boolean(setting.notifyInventoryAlerts),
      notifySyncAndHealth: Boolean(setting.notifySyncAndHealth),
      inventoryReminderHours: setting.inventoryReminderHours,
      staleSyncThresholdHours: setting.staleSyncThresholdHours,
      updatedByBaleId: setting.updatedByBaleId ?? null,
      updatedAt: toTehranWallClockIso(setting.updatedAt),
      sync,
    };
  }

  async updateSettings(
    actorBaleId: string,
    input: UpdateBotSettingsInput,
  ): Promise<BotSettingsDto> {
    const setting = await this.getOrCreateEntity();
    const changedFields: string[] = [];

    if (input.lowStockThreshold !== undefined) {
      const value = Number(input.lowStockThreshold);

      if (!Number.isInteger(value) || value < 1 || value > 1000) {
        throw new BadRequestException(
          'lowStockThreshold must be an integer between 1 and 1000.',
        );
      }

      setting.lowStockThreshold = value;
      changedFields.push(`lowStockThreshold=${value}`);
    }

    if (input.inventoryReminderHours !== undefined) {
      const value = Number(input.inventoryReminderHours);

      if (!Number.isInteger(value) || value < 0 || value > 168) {
        throw new BadRequestException(
          'inventoryReminderHours must be an integer between 0 and 168.',
        );
      }

      setting.inventoryReminderHours = value;
      changedFields.push(`inventoryReminderHours=${value}`);
    }

    if (input.staleSyncThresholdHours !== undefined) {
      const value = Number(input.staleSyncThresholdHours);

      if (!Number.isInteger(value) || value < 6 || value > 720) {
        throw new BadRequestException(
          'staleSyncThresholdHours must be an integer between 6 and 720.',
        );
      }

      setting.staleSyncThresholdHours = value;
      changedFields.push(`staleSyncThresholdHours=${value}`);
    }

    const booleanKeys: Array<
      keyof Pick<
        UpdateBotSettingsInput,
        | 'notifyOrderCreated'
        | 'notifyOrderPaid'
        | 'notifyOrderCancelled'
        | 'notifyOrderStatusChanged'
        | 'notifyInventoryAlerts'
        | 'notifySyncAndHealth'
      >
    > = [
      'notifyOrderCreated',
      'notifyOrderPaid',
      'notifyOrderCancelled',
      'notifyOrderStatusChanged',
      'notifyInventoryAlerts',
      'notifySyncAndHealth',
    ];

    for (const key of booleanKeys) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'boolean') {
          throw new BadRequestException(`${key} must be a boolean.`);
        }

        setting[key] = input[key];
        changedFields.push(`${key}=${String(input[key])}`);
      }
    }

    setting.updatedByBaleId = actorBaleId;

    await this.settingRepo.save(setting);

    this.logger.log(
      `تنظیمات ربات توسط مالک (${actorBaleId}) به‌روزرسانی شد: ${changedFields.join(', ') || 'no-op'}`,
    );

    return this.getSettingsDto();
  }

  async getSyncHealthDto(): Promise<InventorySyncHealthDto> {
    const setting = await this.getOrCreateEntity();
    const fallbackVariantUpdatedAt = await this.getMaxVariantUpdatedAt();

    return this.buildSyncHealthDto(setting, fallbackVariantUpdatedAt);
  }

  buildSyncHealthDto(
    setting: BotSetting,
    fallbackVariantUpdatedAt: string | Date | null,
    now: Date = new Date(),
  ): InventorySyncHealthDto {
    const thresholdHours =
      setting.staleSyncThresholdHours > 0
        ? setting.staleSyncThresholdHours
        : DEFAULT_STALE_SYNC_HOURS;

    const lastSucceededIso = toTehranWallClockIso(setting.lastSyncSucceededAt);
    const fallbackIso = toTehranWallClockIso(fallbackVariantUpdatedAt);
    const effectiveSyncIso = lastSucceededIso ?? fallbackIso;

    let isStale = false;

    if (effectiveSyncIso) {
      const parsedMs = new Date(effectiveSyncIso).getTime();

      if (Number.isFinite(parsedMs)) {
        isStale = now.getTime() - parsedMs > thresholdHours * 3_600_000;
      }
    }

    return {
      status: setting.lastSyncStatus ?? 'never',
      lastStartedAt: toTehranWallClockIso(setting.lastSyncStartedAt),
      lastSucceededAt: lastSucceededIso,
      lastFailedAt: toTehranWallClockIso(setting.lastSyncFailedAt),
      lastError: setting.lastSyncError ?? null,
      isStale,
      staleThresholdHours: thresholdHours,
      fallbackVariantUpdatedAt: fallbackIso,
      stats: setting.lastSyncStats ?? null,
    };
  }

  async getMaxVariantUpdatedAt(): Promise<string | Date | null> {
    if (typeof this.variantRepo?.createQueryBuilder !== 'function') {
      return null;
    }

    const row = await this.variantRepo
      .createQueryBuilder('variant')
      .select('MAX(variant.updatedAt)', 'inventorySyncedAt')
      .getRawOne<{ inventorySyncedAt: string | Date | null }>();

    return row?.inventorySyncedAt ?? null;
  }

  private buildDefaultSetting(): BotSetting {
    const setting = new BotSetting();
    setting.id = 1;
    setting.lowStockThreshold = DEFAULT_LOW_STOCK_THRESHOLD;
    setting.notifyOrderCreated = true;
    setting.notifyOrderPaid = true;
    setting.notifyOrderCancelled = true;
    setting.notifyOrderStatusChanged = true;
    setting.notifyInventoryAlerts = true;
    setting.notifySyncAndHealth = true;
    setting.inventoryReminderHours = 0;
    setting.staleSyncThresholdHours = DEFAULT_STALE_SYNC_HOURS;
    setting.lastSyncStartedAt = null;
    setting.lastSyncSucceededAt = null;
    setting.lastSyncFailedAt = null;
    setting.lastSyncStatus = 'never';
    setting.lastSyncError = null;
    setting.lastSyncStats = null;
    setting.syncIncidentOpen = false;
    setting.syncIncidentCount = 0;
    setting.lastStaleAlertKey = null;
    setting.updatedByBaleId = null;
    setting.updatedAt = new Date();
    return setting;
  }
}
