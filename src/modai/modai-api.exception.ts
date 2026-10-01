import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * خطای اختصاصی درگاه مدآی.
 *
 * مستند مدآی فرمت خطا را تعیین نکرده است؛ برای یکدستی با درگاه ترب، خطاها با
 * بدنهٔ `{ "error": "..." }` برگردانده می‌شوند تا مصرف‌کننده همیشه یک شکل
 * ثابت ببیند.
 */
export class ModaiApiException extends HttpException {
  constructor(message: string, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super(message, status);

    this.name = 'ModaiApiException';
  }

  static badRequest(message: string) {
    return new ModaiApiException(message, HttpStatus.BAD_REQUEST);
  }

  static unauthorized(message: string) {
    return new ModaiApiException(message, HttpStatus.UNAUTHORIZED);
  }
}

@Catch()
export class ModaiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ModaiApiException) {
      response.status(exception.getStatus()).json({ error: exception.message });

      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      let message = exception.message;

      if (typeof payload === 'object' && payload !== null) {
        const rawMessage = (payload as { message?: unknown }).message;

        message = Array.isArray(rawMessage)
          ? rawMessage.join(', ')
          : typeof rawMessage === 'string'
            ? rawMessage
            : message;
      }

      response.status(status).json({ error: message });

      return;
    }

    // خطای پیش‌بینی‌نشده: جزئیات داخلی هرگز به مدآی برگردانده نمی‌شود.
    console.error('[modai] unexpected error:', exception);

    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: 'internal server error' });
  }
}
