import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { BotEventsService } from './bot-events.service';

@Injectable()
export class BotEventsScheduler {
  private readonly logger = new Logger(BotEventsScheduler.name);

  constructor(
    private readonly eventsService: BotEventsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * بررسی ساعتی تازگی همگام‌سازی راهکاران (به وقت تهران).
   * اگر آخرین sync موفق بیش از آستانهٔ مجاز (پیش‌فرض ۳۰ ساعت) قدیمی شده باشد،
   * یک رویداد هشدار بدون تکرار برای مالک ثبت می‌شود.
   */
  @Cron('0 15 * * * *', {
    name: 'bot-stale-sync-monitor',
    timeZone: 'Asia/Tehran',
    waitForCompletion: true,
  })
  async monitorSyncFreshness(): Promise<void> {
    try {
      await this.eventsService.checkStaleSyncAndNotify();
    } catch (error) {
      this.logger.error(
        `بررسی تازگی همگام‌سازی راهکاران خطا خورد: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /**
   * پاک‌سازی روزانهٔ رویدادهای قدیمی Outbox ساعت ۰۳:۳۰ بامداد به وقت تهران.
   */
  @Cron('0 30 3 * * *', {
    name: 'bot-outbox-retention-cleanup',
    timeZone: 'Asia/Tehran',
    waitForCompletion: true,
  })
  async cleanupOldOutboxEvents(): Promise<void> {
    const retentionRaw = Number.parseInt(
      this.config.get<string>('BOT_OUTBOX_RETENTION_DAYS') ?? '30',
      10,
    );
    const retentionDays =
      Number.isFinite(retentionRaw) && retentionRaw >= 1 ? retentionRaw : 30;

    try {
      await this.eventsService.purgeExpiredEvents(
        retentionDays,
        Math.max(retentionDays, 90),
      );
    } catch (error) {
      this.logger.error(
        `پاک‌سازی دوره‌ای outbox خطا خورد: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
}
