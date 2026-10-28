import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, NextFunction, Request, Response, urlencoded } from 'express';

/**
 * بدنه‌ی درخواست فقط وقتی پارس می‌شود که Content-Type در لیست پشتیبانی‌شده باشد.
 * اگر کلاینت — یا یک پراکسی/WAF جلوی سرور — هدر را به `text/plain` تغییر دهد یا
 * بدنه را به‌صورت فرم بفرستد، `req.body` خالی می‌ماند و DTO خطای «فیلد الزامی
 * است»/«طول نامعتبر» می‌دهد، درحالی‌که کلاینت مقدار را فرستاده است. برای همین
 * هر سه قالب رایج را می‌پذیریم.
 */
export const BODY_PARSER_TYPES = [
  'application/json',
  'application/*+json',
  'text/plain',
];

/**
 * اگر درخواستی که بدنه دارد، بدون پارس شدن به هندلر برسد، هشدار لاگ می‌دهیم تا
 * علت خطاهای «فیلد الزامی است» در production قابل ردیابی باشد.
 */
export function logUnparsedBodies(logger: Logger) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const hasPayloadMethod = ['POST', 'PUT', 'PATCH'].includes(
      req.method.toUpperCase(),
    );
    const contentType = String(req.headers['content-type'] ?? '');
    const contentLength = Number(req.headers['content-length'] ?? 0);
    const isMultipart = contentType.startsWith('multipart/form-data');

    const bodyIsEmpty =
      req.body === undefined ||
      (typeof req.body === 'object' &&
        req.body !== null &&
        !Buffer.isBuffer(req.body) &&
        Object.keys(req.body).length === 0);

    if (hasPayloadMethod && !isMultipart && bodyIsEmpty && contentLength > 0) {
      logger.warn(
        `بدنه‌ی درخواست پارس نشد → ${req.method} ${req.originalUrl} ` +
          `(content-type: ${contentType || 'نامشخص'}, content-length: ${contentLength})`,
      );
    }

    next();
  };
}

/**
 * ترتیب مهم است: محدودیت ۴ کیلوبایتی مسیر privacy باید قبل از پارسر عمومی
 * ثبت شود، وگرنه بدنه‌ی آن مسیر با محدودیت پیش‌فرض (۱۰۰ کیلوبایت) پارس می‌شود.
 */
export function setupBodyParsers(app: NestExpressApplication) {
  app.use('/api/privacy', json({ limit: '4kb' }));
  app.use(json({ type: BODY_PARSER_TYPES }));
  app.use(urlencoded({ extended: true, limit: '100kb' }));
  app.use(logUnparsedBodies(new Logger('RequestBody')));
}
