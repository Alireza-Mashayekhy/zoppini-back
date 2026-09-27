import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

import {
  TOROB_SUPPORTED_TOKEN_VERSION,
  TOROB_TOKEN_HEADER,
  TOROB_TOKEN_VERSION_HEADERS,
} from './torob.constants';
import { TorobApiException } from './torob-api.exception';
import { TorobTokenError, verifyTorobToken } from './torob-token.util';

/**
 * گارد امنیتی درگاه ترب.
 *
 * تمام درخواست‌های ترب با یک JWT امضاشده با کلید خصوصی ترب ارسال می‌شوند و
 * با کلید عمومی ترب اعتبارسنجی می‌شوند. علاوه بر آن، `aud` باید با هاست
 * فعلی API برابر باشد تا توکن یک فروشگاه روی فروشگاه دیگر کار نکند.
 */
@Injectable()
export class TorobTokenGuard implements CanActivate {
  private readonly logger = new Logger(TorobTokenGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    // غیرفعال‌سازی موقت برای تست محلی. در محیط واقعی باید `true` بماند.
    if (this.configService.get('TOROB_TOKEN_REQUIRED') === 'false') {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const headers = request.headers ?? {};

    const token = this.readHeader(headers, TOROB_TOKEN_HEADER);

    if (!token) {
      throw TorobApiException.unauthorized('X-Torob-Token header is missing');
    }

    const tokenVersion = TOROB_TOKEN_VERSION_HEADERS.map(name =>
      this.readHeader(headers, name),
    ).find(Boolean);

    if (
      tokenVersion &&
      String(tokenVersion).trim() !== TOROB_SUPPORTED_TOKEN_VERSION
    ) {
      throw TorobApiException.unauthorized(
        `unsupported torob token version header: ${tokenVersion}`,
      );
    }

    const expectedAudience = this.resolveExpectedAudience(request);

    try {
      verifyTorobToken(token, expectedAudience);
    } catch (error) {
      const message =
        error instanceof TorobTokenError ? error.message : 'token is not valid';

      this.logger.warn(`rejected torob request: ${message}`);

      throw TorobApiException.unauthorized(message);
    }

    return true;
  }

  /**
   * اگر `TOROB_EXPECTED_AUDIENCE` تنظیم شده باشد همان ملاک است، در غیر این صورت
   * از هدر `Host` همان درخواست استفاده می‌شود (دقیقاً همان چیزی که ترب
   * به عنوان `aud` در توکن قرار می‌دهد).
   */
  private resolveExpectedAudience(request: Request): string | null {
    const configured = this.configService.get<string>(
      'TOROB_EXPECTED_AUDIENCE',
    );

    if (configured && configured.trim()) {
      return configured.trim();
    }

    const forwardedHost = request.headers['x-forwarded-host'];

    const host =
      (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ||
      request.headers.host ||
      request.get?.('host');

    return host ? String(host).trim() : null;
  }

  private readHeader(headers: Request['headers'], name: string): string | null {
    const value = headers[name];

    if (Array.isArray(value)) {
      return value[0] ?? null;
    }

    return typeof value === 'string' ? value : null;
  }
}
