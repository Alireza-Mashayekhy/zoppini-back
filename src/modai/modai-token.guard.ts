import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

import { ModaiApiException } from './modai-api.exception';

/**
 * گارد اختیاری درگاه مدآی.
 *
 * مستند مدآی احراز هویت را با هدر `Authorization: YOUR-API-TOKEN` تعریف کرده
 * است. بنابراین:
 *  - اگر `MODAI_API_TOKEN` روی سرور تنظیم شده باشد، همان توکن الزامی می‌شود.
 *  - توکن از هدر `Authorization` (هم به شکل خام مطابق مستند و هم
 *    `Bearer <token>`) یا هدرهای `X-API-KEY` / `X-Modai-Token` یا
 *    کوئری‌استرینگ `?token=` خوانده می‌شود.
 *  - اگر توکنی تنظیم نشده باشد درگاه باز است (برای تست محلی و اولین
 *    راه‌اندازی)؛ با `MODAI_TOKEN_REQUIRED=true` می‌توان آن را بست.
 */
@Injectable()
export class ModaiTokenGuard implements CanActivate {
  private readonly logger = new Logger(ModaiTokenGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('MODAI_API_TOKEN')?.trim();

    if (!expected) {
      const required =
        this.configService.get<string>('MODAI_TOKEN_REQUIRED') === 'true';

      if (!required) {
        return true;
      }

      this.logger.error(
        'MODAI_TOKEN_REQUIRED=true است ولی MODAI_API_TOKEN تنظیم نشده؛ همهٔ درخواست‌ها رد می‌شوند.',
      );

      throw ModaiApiException.unauthorized('api token is not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = this.extractToken(request);

    if (!provided || !this.isEqual(provided, expected)) {
      this.logger.warn('rejected modai request: invalid or missing api token');

      throw ModaiApiException.unauthorized('invalid or missing api token');
    }

    return true;
  }

  private extractToken(request: Request): string | null {
    const headers = request.headers ?? {};

    const headerToken =
      this.readHeader(headers, 'x-api-key') ||
      this.readHeader(headers, 'x-modai-token');

    if (headerToken) {
      return headerToken;
    }

    const authorization = this.readHeader(headers, 'authorization');

    if (authorization) {
      // مطابق مستند مدآی: `Authorization: YOUR-API-TOKEN`
      if (!authorization.toLowerCase().startsWith('bearer ')) {
        return authorization;
      }

      return authorization.slice('bearer '.length).trim() || null;
    }

    const queryToken = (request.query as Record<string, unknown> | undefined)
      ?.token;

    if (typeof queryToken === 'string' && queryToken.trim()) {
      return queryToken.trim();
    }

    return null;
  }

  private readHeader(headers: Request['headers'], name: string): string | null {
    const value = headers[name];

    if (Array.isArray(value)) {
      return value[0] ?? null;
    }

    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  /** مقایسهٔ زمان-ثابت برای جلوگیری از حدس‌زدن توکن */
  private isEqual(first: string, second: string): boolean {
    const firstBuffer = Buffer.from(first);
    const secondBuffer = Buffer.from(second);

    if (firstBuffer.length !== secondBuffer.length) {
      return false;
    }

    return timingSafeEqual(firstBuffer, secondBuffer);
  }
}
