import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import {
  BOT_API_KEY_HEADER,
  BOT_CHAT_TYPE_HEADER,
  BOT_TELEGRAM_USER_HEADER,
  BotScope,
} from '../bot.constants';
import { BOT_SCOPES_KEY } from '../decorators/bot-scopes.decorator';
import { BotAuthService, BotPrincipal } from '../services/bot-auth.service';
import {
  isBotTlsEnforced,
  isSecureHttpRequest,
} from '../utils/bot-config.util';

type BotRequest = Request & {
  botPrincipal?: BotPrincipal;
};

function readHeader(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;

  return typeof raw === 'string' ? raw : undefined;
}

@Injectable()
export class BotAuthGuard implements CanActivate {
  constructor(
    private readonly botAuthService: BotAuthService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<BotRequest>();

    // در production هیچ درخواست HTTP پذیرفته نمی‌شود.
    if (
      isBotTlsEnforced() &&
      !isSecureHttpRequest({
        secure: request.secure,
        protocol: request.protocol,
        headers: request.headers,
      })
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'TLS is required for the bot API.',
        error: 'Forbidden',
        code: 'BOT_TLS_REQUIRED',
      });
    }

    const apiKey = readHeader(request, BOT_API_KEY_HEADER);

    // verifyApiKey در حالت «هیچ کلیدی روی سرور تنظیم نشده» 503 می‌دهد؛
    // بنابراین حتی درخواست بدون هدر هم API بسته را نشان می‌دهد.
    const apiKeyIsValid = this.botAuthService.verifyApiKey(apiKey);

    if (!apiKey || !apiKeyIsValid) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid bot credentials.',
        error: 'Unauthorized',
        code: 'BOT_AUTH_FAILED',
      });
    }

    const chatType = readHeader(request, BOT_CHAT_TYPE_HEADER);

    // داده‌های مدیریتی فقط برای گفت‌وگوی خصوصی مجاز است.
    if (chatType !== 'private') {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Bot data is available only in private chats.',
        error: 'Forbidden',
        code: 'BOT_PRIVATE_CHAT_REQUIRED',
      });
    }

    const telegramUserId = readHeader(request, BOT_TELEGRAM_USER_HEADER);

    if (!telegramUserId) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Bot caller identity is missing.',
        error: 'Unauthorized',
        code: 'BOT_CALLER_MISSING',
      });
    }

    const principal = this.botAuthService.resolvePrincipal(telegramUserId);

    // allowlist در سرور enforce می‌شود، نه فقط در رابط ربات.
    if (!principal) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'This Telegram account is not allowed to use the bot.',
        error: 'Forbidden',
        code: 'BOT_NOT_ALLOWED',
      });
    }

    const requiredScopes =
      this.reflector.getAllAndOverride<BotScope[]>(BOT_SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (
      requiredScopes.length > 0 &&
      !requiredScopes.some(scope => principal.scopes.includes(scope))
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'The bot role does not have access to this section.',
        error: 'Forbidden',
        code: 'BOT_SCOPE_FORBIDDEN',
      });
    }

    request.botPrincipal = principal;

    return true;
  }
}
