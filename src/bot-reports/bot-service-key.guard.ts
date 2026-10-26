import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

import {
  BOT_ACTOR_ID_HEADER,
  BOT_CHAT_TYPE_HEADER,
  BOT_NONCE_HEADER,
  BOT_SIGNATURE_HEADER,
  BOT_SIGNATURE_MAX_SKEW_MS,
  BOT_TIMESTAMP_HEADER,
  computeBodySha256,
  computeBotRequestSignature,
  deriveActorSigningKey,
  safeTimingEqual,
} from './bot-auth.util';

export interface BotAuthenticatedRequest extends Request {
  botAuth?: {
    actorType: 'user' | 'system';
    baleUserId: string | null;
    chatType: 'private' | 'system';
  };
}

const MAX_REPLAY_CACHE_ENTRIES = 10_000;

/**
 * احراز هویت دو‌لایه برای ارتباط سرویس‌به‌سرویس ربات بله با سایت:
 *   ۱. بررسی توکن سرویس (`ZOPPINI_BOT_SERVICE_TOKEN` + پشتیبانی از کلید چرخشی
 *      `ZOPPINI_BOT_SERVICE_TOKEN_PREVIOUS`) با مقایسهٔ زمان-ثابت.
 *   ۲. بررسی امضای HMAC-SHA256 روی شناسهٔ کاربر بله (`X-Bot-Actor-Id`)، نوع چت،
 *      متد، مسیر+کوئری، بدنه، timestamp و nonce یکبارمصرف تا هدر کاربر بله
 *      غیرقابل‌جعل و مقاوم در برابر تکرار (Replay) باشد.
 *
 * هیچ توکن، secret، امضا یا دادهٔ شخصی در لاگ ثبت نمی‌شود.
 */
@Injectable()
export class BotServiceKeyGuard implements CanActivate {
  private readonly logger = new Logger(BotServiceKeyGuard.name);
  private readonly seenNonces = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const primaryToken = this.config
      .get<string>('ZOPPINI_BOT_SERVICE_TOKEN')
      ?.trim();
    const previousToken = this.config
      .get<string>('ZOPPINI_BOT_SERVICE_TOKEN_PREVIOUS')
      ?.trim();

    const validServiceTokens = [primaryToken, previousToken].filter(
      (token): token is string => Boolean(token),
    );

    if (validServiceTokens.length === 0) {
      this.logger.error(
        'ZOPPINI_BOT_SERVICE_TOKEN تنظیم نشده است؛ API ربات غیرفعال (fail-closed) است.',
      );
      throw new ServiceUnavailableException(
        'Bot service authentication is not configured.',
      );
    }

    const request = context
      .switchToHttp()
      .getRequest<BotAuthenticatedRequest>();
    const authorization = this.readHeader(request, 'authorization');
    const suppliedBearer =
      authorization && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : '';

    const matchedServiceToken = validServiceTokens.find(candidate =>
      safeTimingEqual(suppliedBearer, candidate),
    );

    if (!matchedServiceToken) {
      this.logger.warn(
        `درخواست ربات به دلیل توکن سرویس نامعتبر یا غایب رد شد (method=${request.method}).`,
      );
      throw new UnauthorizedException('Invalid service credentials.');
    }

    const actorId = this.readHeader(request, BOT_ACTOR_ID_HEADER);
    const chatType = this.readHeader(request, BOT_CHAT_TYPE_HEADER);
    const timestampRaw = this.readHeader(request, BOT_TIMESTAMP_HEADER);
    const nonce = this.readHeader(request, BOT_NONCE_HEADER);
    const signature = this.readHeader(request, BOT_SIGNATURE_HEADER);

    if (!actorId || !chatType || !timestampRaw || !nonce || !signature) {
      this.logger.warn(
        `درخواست ربات به دلیل ناقص‌بودن هدرهای امضای هویت رد شد (method=${request.method}).`,
      );
      throw new UnauthorizedException('Missing signed actor headers.');
    }

    if (actorId !== 'system' && !/^\d{1,20}$/.test(actorId)) {
      this.logger.warn('درخواست ربات با فرمت نامعتبر شناسهٔ کاربر رد شد.');
      throw new UnauthorizedException('Invalid actor identifier.');
    }

    if (
      (actorId === 'system' && chatType !== 'system') ||
      (actorId !== 'system' && chatType !== 'private')
    ) {
      this.logger.warn(
        `درخواست ربات به دلیل نوع چت غیرمجاز رد شد (actor=${actorId}, chatType=${chatType}).`,
      );
      throw new UnauthorizedException(
        'Bot API only accepts private user chats or system worker requests.',
      );
    }

    if (!/^[\w-]{8,128}$/.test(nonce)) {
      this.logger.warn('درخواست ربات با nonce نامعتبر رد شد.');
      throw new UnauthorizedException('Invalid request nonce.');
    }

    const timestampMs = Number(timestampRaw);
    const nowMs = Date.now();

    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(nowMs - timestampMs) > BOT_SIGNATURE_MAX_SKEW_MS
    ) {
      this.logger.warn('درخواست ربات به دلیل انقضای زمان امضا رد شد.');
      throw new UnauthorizedException('Expired or skewed request timestamp.');
    }

    this.pruneExpiredNonces(nowMs);

    if (this.seenNonces.has(nonce)) {
      this.logger.warn('درخواست تکراری (replay) در API ربات مسدود شد.');
      throw new UnauthorizedException('Replay detected.');
    }

    const pathWithQuery = request.originalUrl || request.url || '/';
    const bodySha256 =
      request.method === 'GET' || request.method === 'HEAD'
        ? computeBodySha256('')
        : computeBodySha256(request.body);

    const candidateSigningKeys = this.resolveSigningKeys(validServiceTokens);
    const signatureFields = {
      timestamp: timestampRaw,
      nonce,
      method: request.method || 'GET',
      pathWithQuery,
      actorId,
      chatType,
      bodySha256,
    };

    const signatureValid = candidateSigningKeys.some(signingKey =>
      safeTimingEqual(
        signature,
        computeBotRequestSignature(signingKey, signatureFields),
      ),
    );

    if (!signatureValid) {
      this.logger.warn(
        `درخواست ربات به دلیل امضای نامعتبر هویت رد شد (method=${request.method}).`,
      );
      throw new UnauthorizedException('Invalid actor signature.');
    }

    this.recordNonce(nonce, nowMs + BOT_SIGNATURE_MAX_SKEW_MS);

    request.botAuth = {
      actorType: actorId === 'system' ? 'system' : 'user',
      baleUserId: actorId === 'system' ? null : actorId,
      chatType: actorId === 'system' ? 'system' : 'private',
    };

    return true;
  }

  private resolveSigningKeys(serviceTokens: string[]): string[] {
    const primarySigning = this.config
      .get<string>('ZOPPINI_BOT_SIGNING_SECRET')
      ?.trim();
    const previousSigning = this.config
      .get<string>('ZOPPINI_BOT_SIGNING_SECRET_PREVIOUS')
      ?.trim();

    const keys = new Set<string>();

    if (primarySigning) {
      keys.add(primarySigning);
    }

    if (previousSigning) {
      keys.add(previousSigning);
    }

    for (const token of serviceTokens) {
      keys.add(deriveActorSigningKey(token, null));
    }

    return [...keys];
  }

  private readHeader(request: Request, name: string): string {
    const raw = request.headers?.[name];

    if (Array.isArray(raw)) {
      return (raw[0] ?? '').trim();
    }

    return typeof raw === 'string' ? raw.trim() : '';
  }

  private pruneExpiredNonces(nowMs: number): void {
    if (this.seenNonces.size < 256) {
      return;
    }

    for (const [key, expiresAt] of this.seenNonces.entries()) {
      if (expiresAt <= nowMs) {
        this.seenNonces.delete(key);
      }
    }
  }

  private recordNonce(nonce: string, expiresAt: number): void {
    if (this.seenNonces.size >= MAX_REPLAY_CACHE_ENTRIES) {
      const oldestKey = this.seenNonces.keys().next().value as
        string | undefined;

      if (oldestKey) {
        this.seenNonces.delete(oldestKey);
      }
    }

    this.seenNonces.set(nonce, expiresAt);
  }
}
