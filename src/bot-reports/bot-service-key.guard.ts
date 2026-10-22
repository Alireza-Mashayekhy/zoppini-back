import { timingSafeEqual } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * احراز هویت سرویس‌به‌سرویس برای API گزارش‌های ربات بله.
 *
 * ربات باید هدر `Authorization: Bearer <ZOPPINI_BOT_SERVICE_TOKEN>` بفرستد.
 * اگر توکن روی بک‌اند تنظیم نشده باشد endpointها عمداً بسته‌اند (503) تا
 * گزارش‌های فروش بدون secret در دسترس نباشند. خود توکن هیچ‌جا لاگ نمی‌شود.
 */
@Injectable()
export class BotServiceKeyGuard implements CanActivate {
  private readonly logger = new Logger(BotServiceKeyGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config
      .get<string>('ZOPPINI_BOT_SERVICE_TOKEN')
      ?.trim();

    if (!expected) {
      this.logger.error(
        'ZOPPINI_BOT_SERVICE_TOKEN تنظیم نشده است؛ API گزارش‌های ربات غیرفعال است.',
      );
      throw new ServiceUnavailableException();
    }

    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.authorization;
    const supplied =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';

    if (!supplied || !this.isEqual(supplied, expected)) {
      this.logger.warn('درخواست ربات با توکن نامعتبر یا بدون توکن رد شد.');
      throw new UnauthorizedException();
    }

    return true;
  }

  /** مقایسهٔ زمان-ثابت برای جلوگیری از حدس‌زدن توکن */
  private isEqual(supplied: string, expected: string): boolean {
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);

    if (suppliedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(suppliedBuffer, expectedBuffer);
  }
}
