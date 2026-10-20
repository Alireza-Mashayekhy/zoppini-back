import { SetMetadata } from '@nestjs/common';

import { BotScope } from '../bot.constants';

export const BOT_SCOPES_KEY = 'bot_scopes';

/**
 * اگر روی handler یا controller استفاده شود، نقش فراخوان باید حداقل
 * یکی از scopeهای اعلام‌شده را داشته باشد.
 */
export const BotScopes = (...scopes: BotScope[]) =>
  SetMetadata(BOT_SCOPES_KEY, scopes);
