import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  BotCallerProfileDto,
  BotOperatorDto,
  BotPermission,
} from './bot-reports.contract';
import { BotOperator, BotOperatorRole } from './entities/bot-operator.entity';
import { BotNotificationCategory } from './entities/bot-outbox-event.entity';

const ROLE_PERMISSIONS: Record<BotOperatorRole, BotPermission[]> = {
  [BotOperatorRole.OWNER]: [
    'orders:summary',
    'orders:read',
    'orders:customer_pii',
    'sales:read',
    'sales:export',
    'customers:read',
    'inventory:read',
    'inventory:export',
    'alerts:read',
    'alerts:manage',
    'settings:read',
    'settings:write',
    'roles:manage',
  ],
  [BotOperatorRole.ADMIN]: [
    'orders:summary',
    'orders:read',
    'orders:customer_pii',
    'sales:read',
    'sales:export',
    'customers:read',
    'inventory:read',
    'inventory:export',
    'alerts:read',
    'settings:read',
  ],
  [BotOperatorRole.ORDERS_READ_ONLY]: ['orders:summary', 'orders:read'],
  [BotOperatorRole.REPORTS_READ_ONLY]: [
    'orders:summary',
    'orders:read',
    'sales:read',
    'sales:export',
    'customers:read',
    'inventory:read',
    'inventory:export',
    'alerts:read',
  ],
};

export function normalizeBotOperatorRole(
  rawRole: unknown,
): BotOperatorRole | null {
  const normalized =
    typeof rawRole === 'string'
      ? rawRole.trim().toLowerCase().replace(/_/g, '-')
      : '';

  switch (normalized) {
    case 'owner':
      return BotOperatorRole.OWNER;
    case 'admin':
      return BotOperatorRole.ADMIN;
    case 'orders-read-only':
    case 'orders-readonly':
      return BotOperatorRole.ORDERS_READ_ONLY;
    case 'reports-read-only':
    case 'reports-readonly':
      return BotOperatorRole.REPORTS_READ_ONLY;
    default:
      return null;
  }
}

export function permissionsForRole(role: BotOperatorRole): BotPermission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/**
 * سرویس مدیریت نقش‌ها و مجوزهای کاربران بله در سمت سرور (RBAC).
 *
 * منبع حقیقت ترکیب امن env سرور (`ZOPPINI_BOT_OWNER_BALE_IDS` و
 * `ZOPPINI_BOT_ROLE_MAP`) و جدول پایدار `bot_operators` است. مالکان تعریف‌شده
 * در env هرگز از طریق رابط کاربری قابل حذف یا تنزل نقش نیستند تا قفل‌شدن تصادفی
 * رخ ندهد.
 */
@Injectable()
export class BotAccessService {
  private readonly logger = new Logger(BotAccessService.name);

  constructor(
    @InjectRepository(BotOperator)
    private readonly operatorRepo: Repository<BotOperator>,
    private readonly config: ConfigService,
  ) {}

  async getCallerProfile(baleUserId: string): Promise<BotCallerProfileDto> {
    const resolved = await this.resolveOperator(baleUserId);

    if (!resolved || !resolved.isActive) {
      return {
        authorized: false,
        baleUserId,
        role: null,
        permissions: [],
      };
    }

    return {
      authorized: true,
      baleUserId,
      role: resolved.role,
      permissions: permissionsForRole(resolved.role),
    };
  }

  async resolveOperator(baleUserId: string): Promise<BotOperatorDto | null> {
    if (!/^\d{1,20}$/.test(baleUserId)) {
      return null;
    }

    const envMap = this.readEnvRoleMap();
    const envRole = envMap.get(baleUserId) ?? null;

    const dbRow = await this.findOperatorRowSafely(baleUserId);

    if (!envRole && !dbRow) {
      return null;
    }

    const isEnvOwner = envRole === BotOperatorRole.OWNER;
    const effectiveRole = isEnvOwner
      ? BotOperatorRole.OWNER
      : (dbRow?.role ?? envRole!);
    const isActive = isEnvOwner ? true : (dbRow?.isActive ?? true);

    return {
      baleUserId,
      role: effectiveRole,
      label: dbRow?.label ?? (isEnvOwner ? 'مالک (تنظیم سرور)' : null),
      isActive,
      isEnvPinned: envRole !== null,
      receiveOrderAlerts: dbRow?.receiveOrderAlerts ?? true,
      receiveInventoryAlerts: dbRow?.receiveInventoryAlerts ?? true,
      receiveHealthAlerts:
        dbRow?.receiveHealthAlerts ??
        (effectiveRole === BotOperatorRole.OWNER ||
          effectiveRole === BotOperatorRole.ADMIN),
      updatedAt: dbRow?.updatedAt ? dbRow.updatedAt.toISOString() : null,
    };
  }

  async listOperators(): Promise<BotOperatorDto[]> {
    const envMap = this.readEnvRoleMap();
    const dbRows = await this.findAllOperatorRowsSafely();

    const byId = new Map<string, BotOperator>();

    for (const row of dbRows) {
      byId.set(row.baleUserId, row);
    }

    const allIds = new Set<string>([...envMap.keys(), ...byId.keys()]);
    const results: BotOperatorDto[] = [];

    for (const baleUserId of allIds) {
      const envRole = envMap.get(baleUserId) ?? null;
      const dbRow = byId.get(baleUserId);
      const isEnvOwner = envRole === BotOperatorRole.OWNER;
      const effectiveRole = isEnvOwner
        ? BotOperatorRole.OWNER
        : (dbRow?.role ?? envRole!);

      results.push({
        baleUserId,
        role: effectiveRole,
        label: dbRow?.label ?? (isEnvOwner ? 'مالک (تنظیم سرور)' : null),
        isActive: isEnvOwner ? true : (dbRow?.isActive ?? true),
        isEnvPinned: envRole !== null,
        receiveOrderAlerts: dbRow?.receiveOrderAlerts ?? true,
        receiveInventoryAlerts: dbRow?.receiveInventoryAlerts ?? true,
        receiveHealthAlerts:
          dbRow?.receiveHealthAlerts ??
          (effectiveRole === BotOperatorRole.OWNER ||
            effectiveRole === BotOperatorRole.ADMIN),
        updatedAt: dbRow?.updatedAt ? dbRow.updatedAt.toISOString() : null,
      });
    }

    return results.sort((a, b) => a.baleUserId.localeCompare(b.baleUserId));
  }

  async upsertOperator(input: {
    actorBaleId: string;
    targetBaleUserId: string;
    role?: string;
    label?: string | null;
    isActive?: boolean;
    receiveOrderAlerts?: boolean;
    receiveInventoryAlerts?: boolean;
    receiveHealthAlerts?: boolean;
  }): Promise<BotOperatorDto> {
    const targetId = String(input.targetBaleUserId ?? '').trim();

    if (!/^\d{1,20}$/.test(targetId)) {
      throw new BadRequestException(
        'baleUserId must be a valid positive numeric Bale user ID.',
      );
    }

    const envMap = this.readEnvRoleMap();
    const isEnvOwner = envMap.get(targetId) === BotOperatorRole.OWNER;

    let existing = await this.operatorRepo.findOne({
      where: { baleUserId: targetId },
    });

    const parsedRole =
      input.role !== undefined
        ? normalizeBotOperatorRole(input.role)
        : (existing?.role ?? envMap.get(targetId) ?? null);

    if (!parsedRole) {
      throw new BadRequestException(
        'Invalid role. Allowed roles: owner, admin, orders-read-only, reports-read-only.',
      );
    }

    if (
      isEnvOwner &&
      (parsedRole !== BotOperatorRole.OWNER || input.isActive === false)
    ) {
      throw new ForbiddenException(
        'مالک تعریف‌شده در تنظیمات سرور قابل غیرفعال‌سازی یا تغییر نقش نیست.',
      );
    }

    if (input.label !== undefined && input.label !== null) {
      const cleanLabel = String(input.label).trim();

      if (cleanLabel.length > 120) {
        throw new BadRequestException('label must not exceed 120 characters.');
      }
    }

    if (!existing) {
      existing = this.operatorRepo.create({
        baleUserId: targetId,
        role: isEnvOwner ? BotOperatorRole.OWNER : parsedRole,
        label: input.label ? String(input.label).trim() : null,
        isActive: input.isActive ?? true,
        receiveOrderAlerts: input.receiveOrderAlerts ?? true,
        receiveInventoryAlerts: input.receiveInventoryAlerts ?? true,
        receiveHealthAlerts:
          input.receiveHealthAlerts ??
          (parsedRole === BotOperatorRole.OWNER ||
            parsedRole === BotOperatorRole.ADMIN),
        updatedByBaleId: input.actorBaleId,
      });
    } else {
      existing.role = isEnvOwner ? BotOperatorRole.OWNER : parsedRole;

      if (input.label !== undefined) {
        existing.label = input.label ? String(input.label).trim() : null;
      }

      if (input.isActive !== undefined) {
        existing.isActive = isEnvOwner ? true : Boolean(input.isActive);
      }

      if (input.receiveOrderAlerts !== undefined) {
        existing.receiveOrderAlerts = Boolean(input.receiveOrderAlerts);
      }

      if (input.receiveInventoryAlerts !== undefined) {
        existing.receiveInventoryAlerts = Boolean(input.receiveInventoryAlerts);
      }

      if (input.receiveHealthAlerts !== undefined) {
        existing.receiveHealthAlerts = Boolean(input.receiveHealthAlerts);
      }

      existing.updatedByBaleId = input.actorBaleId;
    }

    await this.operatorRepo.save(existing);

    this.logger.log(
      `تغییر دسترسی اپراتور ربات ثبت شد: target=${targetId}, role=${existing.role}, active=${existing.isActive}, by=${input.actorBaleId}`,
    );

    const resolved = await this.resolveOperator(targetId);

    return resolved!;
  }

  async deactivateOperator(
    actorBaleId: string,
    targetBaleUserId: string,
  ): Promise<{ baleUserId: string; isActive: boolean }> {
    const targetId = String(targetBaleUserId ?? '').trim();

    if (!/^\d{1,20}$/.test(targetId)) {
      throw new BadRequestException('Invalid Bale user ID.');
    }

    const envMap = this.readEnvRoleMap();

    if (envMap.get(targetId) === BotOperatorRole.OWNER) {
      throw new ForbiddenException(
        'مالک تعریف‌شده در تنظیمات سرور قابل حذف یا غیرفعال‌سازی نیست.',
      );
    }

    if (targetId === actorBaleId) {
      throw new BadRequestException(
        'حذف دسترسی حساب فعلی خودتان مجاز نیست تا دسترسی مدیریتی از دست نرود.',
      );
    }

    let existing = await this.operatorRepo.findOne({
      where: { baleUserId: targetId },
    });

    if (!existing) {
      if (!envMap.has(targetId)) {
        throw new BadRequestException('اپراتور موردنظر یافت نشد.');
      }

      existing = this.operatorRepo.create({
        baleUserId: targetId,
        role: envMap.get(targetId)!,
        isActive: false,
        updatedByBaleId: actorBaleId,
      });
    } else {
      existing.isActive = false;
      existing.updatedByBaleId = actorBaleId;
    }

    await this.operatorRepo.save(existing);

    this.logger.log(
      `دسترسی اپراتور ربات غیرفعال شد: target=${targetId}, by=${actorBaleId}`,
    );

    return { baleUserId: targetId, isActive: false };
  }

  /**
   * استخراج فهرست شناسه‌های عددی مجاز (فقط چت خصوصی مثبت) برای دریافت یک دسته اعلان.
   */
  async resolveAuthorizedRecipients(
    category: BotNotificationCategory,
  ): Promise<string[]> {
    const operators = await this.listOperators();

    return operators
      .filter(op => op.isActive && /^\d{1,20}$/.test(op.baleUserId))
      .filter(op => {
        const perms = permissionsForRole(op.role);

        switch (category) {
          case BotNotificationCategory.ORDER_CREATED:
          case BotNotificationCategory.ORDER_PAID:
          case BotNotificationCategory.ORDER_CANCELLED:
          case BotNotificationCategory.ORDER_STATUS:
            return op.receiveOrderAlerts && perms.includes('orders:read');

          case BotNotificationCategory.INVENTORY:
            return (
              op.receiveInventoryAlerts && perms.includes('inventory:read')
            );

          case BotNotificationCategory.SYNC_HEALTH:
            return (
              op.receiveHealthAlerts &&
              (op.role === BotOperatorRole.OWNER ||
                op.role === BotOperatorRole.ADMIN)
            );

          default:
            return false;
        }
      })
      .map(op => op.baleUserId);
  }

  private readEnvRoleMap(): Map<string, BotOperatorRole> {
    const map = new Map<string, BotOperatorRole>();

    const roleMapRaw =
      this.config.get<string>('ZOPPINI_BOT_ROLE_MAP')?.trim() ?? '';

    for (const entry of roleMapRaw.split(',')) {
      const trimmed = entry.trim();

      if (!trimmed) continue;

      const [rawId, rawRole] = trimmed.split(':').map(part => part.trim());
      const role = normalizeBotOperatorRole(rawRole);

      if (/^\d{1,20}$/.test(rawId) && role) {
        map.set(rawId, role);
      }
    }

    const ownerIdsRaw =
      this.config.get<string>('ZOPPINI_BOT_OWNER_BALE_IDS')?.trim() ?? '';

    for (const rawId of ownerIdsRaw.split(',')) {
      const id = rawId.trim();

      if (/^\d{1,20}$/.test(id)) {
        map.set(id, BotOperatorRole.OWNER);
      }
    }

    // سازگاری رو به عقب با تنظیم اولیهٔ تک‌مالکی ALLOWED_BALE_IDS اگر متغیرهای جدید ست نشده باشند
    if (map.size === 0) {
      const legacyAllowed =
        this.config.get<string>('ALLOWED_BALE_IDS')?.trim() ?? '';

      for (const rawId of legacyAllowed.split(',')) {
        const id = rawId.trim();

        if (/^\d{1,20}$/.test(id)) {
          map.set(id, BotOperatorRole.OWNER);
        }
      }
    }

    return map;
  }

  private async findOperatorRowSafely(
    baleUserId: string,
  ): Promise<BotOperator | null> {
    try {
      if (typeof this.operatorRepo?.findOne !== 'function') {
        return null;
      }

      return await this.operatorRepo.findOne({ where: { baleUserId } });
    } catch (error) {
      this.logger.error(
        `خطا در خواندن جدول bot_operators: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return null;
    }
  }

  private async findAllOperatorRowsSafely(): Promise<BotOperator[]> {
    try {
      if (typeof this.operatorRepo?.find !== 'function') {
        return [];
      }

      return await this.operatorRepo.find();
    } catch (error) {
      this.logger.error(
        `خطا در خواندن فهرست bot_operators: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return [];
    }
  }
}
