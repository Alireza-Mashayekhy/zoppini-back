import { SetMetadata } from '@nestjs/common';

import { BotPermission } from './bot-reports.contract';

export const BOT_ACCESS_METADATA_KEY = 'zoppini_bot_access_policy';

export interface BotAccessPolicy {
  mode: 'authenticated_user' | 'permissions' | 'system_only' | 'system_or_user';
  permissions?: BotPermission[];
}

/** مسیرهایی که فقط برای تشخیص دسترسی اولیهٔ کاربر در چت خصوصی استفاده می‌شوند (`/me`) */
export const BotAnyPrivateActor = () =>
  SetMetadata(BOT_ACCESS_METADATA_KEY, {
    mode: 'authenticated_user',
  } satisfies BotAccessPolicy);

/** مسیرهای گزارشی/تنظیماتی که نیازمند نقش معتبر سمت سرور و چت خصوصی هستند */
export const BotRequirePermissions = (...permissions: BotPermission[]) =>
  SetMetadata(BOT_ACCESS_METADATA_KEY, {
    mode: 'permissions',
    permissions,
  } satisfies BotAccessPolicy);

/** مسیرهای داخلی worker ربات (مثل lease/ack صف اعلان‌ها) */
export const BotSystemWorkerOnly = () =>
  SetMetadata(BOT_ACCESS_METADATA_KEY, {
    mode: 'system_only',
  } satisfies BotAccessPolicy);

/** مسیرهایی که هم worker سلامت‌سنج و هم مدیر دارای مجوز می‌توانند فراخوانی کنند */
export const BotSystemOrPermissions = (...permissions: BotPermission[]) =>
  SetMetadata(BOT_ACCESS_METADATA_KEY, {
    mode: 'system_or_user',
    permissions,
  } satisfies BotAccessPolicy);
