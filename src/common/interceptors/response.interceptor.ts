import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map } from 'rxjs/operators';

import { RAW_RESPONSE_KEY } from '../decorators/raw-response.decorator';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const response = context.switchToHttp().getResponse();

    const isRaw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isRaw) {
      return next.handle();
    }

    return next.handle().pipe(
      map(result => ({
        status: response.statusCode,
        message: result?.message ?? 'success',
        data: result?.data ?? result,
        pagination: result?.pagination ?? undefined,
        ...(result?.stats ? { stats: result.stats } : {}),
      })),
    );
  }
}
