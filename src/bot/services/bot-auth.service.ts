import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

import { BOT_ROLE_SCOPES, BotRole, BotScope } from '../bot.constants';

export interface BotPrincipal {
  telegramUserId: string;
  role: BotRole;
  scopes: BotScope[];
}

/**
 * احراز هویت سرویس‌به‌سرویس ربات.
 *
 * - کلید API جدا از JWT/کوکی پنل مدیر است.
 * - مقایسه با timingSafeEqual روی digest انجام می‌شود.
 * - allowlist تلگرام و نقش‌ها در همین سمت سرور enforce می‌شوند؛
 *   فقط به هدر ارسالی ربات اعتماد نمی‌کنیم.
 * - هیچ مقدار secret در لاگ نوشته نمی‌شود.
 */
@Injectable()
export class BotAuthService {
  private readonly logger = new Logger(BotAuthService.name);
  private warnedAboutShortKey = false;

  private digest(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
  }

  private getConfiguredKeys(): string[] {
    const rawKeys = [process.env.BOT_API_KEY, process.env.BOT_API_KEY_PREVIOUS];

    const keys: string[] = [];

    for (const raw of rawKeys) {
      const key = (raw ?? '').trim();

      if (!key) {
        continue;
      }

      // کلید کوتاه‌تر از 32 کاراکتر قابل قبول نیست. مقدار آن لاگ نمی‌شود.
      if (key.length < 32) {
        if (!this.warnedAboutShortKey) {
          this.warnedAboutShortKey = true;
          this.logger.error(
            'BOT_API_KEY is shorter than 32 characters and was ignored. Generate a long random key.',
          );
        }
        continue;
      }

      keys.push(key);
    }

    return keys;
  }

  /**
   * اگر هیچ کلید معتبری تنظیم نشده باشد، API کاملاً بسته است (fail closed).
   */
  verifyApiKey(providedKey: string | undefined): boolean {
    const configuredKeys = this.getConfiguredKeys();

    if (!configuredKeys.length) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: 'Bot API is not configured on this server.',
        error: 'Service Unavailable',
        code: 'BOT_API_DISABLED',
      });
    }

    const provided = (providedKey ?? '').trim();

    if (!provided) {
      return false;
    }

    const providedDigest = this.digest(provided);
    let matched = false;

    for (const expectedKey of configuredKeys) {
      const expectedDigest = this.digest(expectedKey);

      // digestها همیشه 32 بایت هستند؛ timingSafeEqual طول برابر می‌خواهد.
      if (timingSafeEqual(providedDigest, expectedDigest)) {
        matched = true;
      }
    }

    return matched;
  }

  private parseTelegramIds(raw: string | undefined): Set<string> {
    const ids = new Set<string>();

    for (const part of (raw ?? '').split(',')) {
      const id = part.trim();

      if (/^\d{1,20}$/.test(id)) {
        ids.add(id);
      }
    }

    return ids;
  }

  private resolveRole(telegramUserId: string): BotRole | null {
    // اولویت: owner > admin > reports_readonly > orders_readonly
    const roleSources: { role: BotRole; envName: string }[] = [
      { role: BotRole.OWNER, envName: 'BOT_OWNER_TELEGRAM_IDS' },
      { role: BotRole.ADMIN, envName: 'BOT_ADMIN_TELEGRAM_IDS' },
      {
        role: BotRole.REPORTS_READONLY,
        envName: 'BOT_REPORTS_READONLY_TELEGRAM_IDS',
      },
      {
        role: BotRole.ORDERS_READONLY,
        envName: 'BOT_ORDERS_READONLY_TELEGRAM_IDS',
      },
    ];

    for (const source of roleSources) {
      const ids = this.parseTelegramIds(process.env[source.envName]);

      if (ids.has(telegramUserId)) {
        return source.role;
      }
    }

    return null;
  }

  /**
   * شناسه‌ی عددی تلگرام باید در allowlist سمت سرور باشد؛
   * در غیر این صورت هیچ داده‌ای برگردانده نمی‌شود.
   */
  resolvePrincipal(telegramUserId: string): BotPrincipal | null {
    const normalized = (telegramUserId ?? '').trim();

    if (!/^\d{1,20}$/.test(normalized)) {
      return null;
    }

    const role = this.resolveRole(normalized);

    if (!role) {
      return null;
    }

    return {
      telegramUserId: normalized,
      role,
      scopes: BOT_ROLE_SCOPES[role],
    };
  }
}
