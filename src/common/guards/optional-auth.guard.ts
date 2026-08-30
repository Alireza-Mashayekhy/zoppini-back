// src/common/guards/optional-auth.guard.ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      // اگر توکن وجود نداشت، به عنوان مهمان ادامه بده
      return true;
    }

    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_ACCESS_SECRET,
      });
      request['user'] = payload;
    } catch {
      // اگر توکن نامعتبر بود، باز هم ادامه بده (مهمان)
    }

    return true;
  }

  private extractToken(request: Request): string | undefined {
    return request.cookies?.access_token;
  }
}
