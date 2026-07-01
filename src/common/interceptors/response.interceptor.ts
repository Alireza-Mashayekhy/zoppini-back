import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const response = context.switchToHttp().getResponse();

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
