import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  BOT_ACCESS_METADATA_KEY,
  BotAccessPolicy,
} from './bot-access.decorator';
import { BotAccessService, permissionsForRole } from './bot-access.service';
import { BotOperatorDto, BotPermission } from './bot-reports.contract';
import { BotAuthenticatedRequest } from './bot-service-key.guard';

export interface BotAuthorizedRequest extends BotAuthenticatedRequest {
  botOperator?: BotOperatorDto;
  botPermissions?: BotPermission[];
}

@Injectable()
export class BotRoleGuard implements CanActivate {
  private readonly logger = new Logger(BotRoleGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly accessService: BotAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<
      BotAccessPolicy | undefined
    >(BOT_ACCESS_METADATA_KEY, [context.getHandler(), context.getClass()]);

    const request = context.switchToHttp().getRequest<BotAuthorizedRequest>();
    const auth = request.botAuth;

    if (!auth) {
      throw new ForbiddenException('Missing verified bot actor context.');
    }

    if (!policy) {
      throw new ForbiddenException('Endpoint access policy is not defined.');
    }

    if (policy.mode === 'system_only') {
      if (auth.actorType !== 'system' || auth.chatType !== 'system') {
        this.logger.warn(
          'تلاش غیرمجاز برای فراخوانی مسیر داخلی worker ربات مسدود شد.',
        );
        throw new ForbiddenException(
          'This endpoint is restricted to the internal bot worker.',
        );
      }

      return true;
    }

    if (policy.mode === 'system_or_user' && auth.actorType === 'system') {
      if (auth.chatType !== 'system') {
        throw new ForbiddenException('Invalid system chat context.');
      }

      return true;
    }

    if (auth.actorType !== 'user' || !auth.baleUserId) {
      this.logger.warn(
        'درخواست کاربر ربات بدون شناسهٔ عددی معتبر بله مسدود شد.',
      );
      throw new ForbiddenException('Valid Bale user identity is required.');
    }

    if (auth.chatType !== 'private') {
      this.logger.warn(
        `درخواست ربات خارج از گفت‌وگوی خصوصی رد شد (chatType=${auth.chatType}).`,
      );
      throw new ForbiddenException(
        'دسترسی به گزارش‌ها فقط در گفت‌وگوی خصوصی مجاز است.',
      );
    }

    if (policy.mode === 'authenticated_user') {
      return true;
    }

    const operator = await this.accessService.resolveOperator(auth.baleUserId);

    if (!operator || !operator.isActive) {
      this.logger.warn(
        `تلاش دسترسی ناموفق به API ربات توسط شناسهٔ غیرمجاز (baleId=${auth.baleUserId}).`,
      );
      throw new ForbiddenException(
        'حساب شما در فهرست مجاز ربات فعال نشده است.',
      );
    }

    const granted = permissionsForRole(operator.role);
    const required = policy.permissions ?? [];
    const missing = required.filter(perm => !granted.includes(perm));

    if (missing.length > 0) {
      this.logger.warn(
        `رد دسترسی بر اساس نقش: baleId=${auth.baleUserId}, role=${operator.role}, missing=${missing.join(',')}`,
      );
      throw new ForbiddenException(
        'نقش کاربری شما مجوز دسترسی به این بخش یا عملیات را ندارد.',
      );
    }

    request.botOperator = operator;
    request.botPermissions = granted;

    return true;
  }
}
