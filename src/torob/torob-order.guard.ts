import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

import { verifyTorobToken } from './torob-token.util';

@Injectable()
export class TorobOrderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (process.env.TOROB_TRACKING_ENABLED !== 'true')
      throw new ForbiddenException();
    const request = context.switchToHttp().getRequest<Request>();
    // Pin the public Host, never trust a client-provided forwarded-host.
    // The reverse proxy must pass the public Host through unchanged.
    const host = request.headers.host;
    const configured = process.env.TOROB_TRACKING_HOST?.trim();
    if (!configured || !host || host !== configured)
      throw new UnauthorizedException();
    const token = request.headers['x-torob-token'];
    if (
      typeof token !== 'string' ||
      token.length > 4096 ||
      request.headers['x-torob-token-version'] !== '1'
    )
      throw new UnauthorizedException();
    try {
      const verified = verifyTorobToken(token, configured, {
        clockSkewSeconds: 0,
        requireNbf: true,
      });
      if (verified.payload.aud !== configured)
        throw new UnauthorizedException();
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
