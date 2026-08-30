import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { Express } from 'express';

@Injectable()
export class FileSizeArrayValidationPipe implements PipeTransform {
  private readonly maxSize = 1024 * 1024 * 2; // 2MB
  private readonly allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];

  transform(files: Express.Multer.File[]) {
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new BadRequestException('هیچ فایلی ارسال نشده است.');
    }

    for (const file of files) {
      if (!file) continue;
      if (!file.mimetype || !this.allowedMimes.includes(file.mimetype)) {
        throw new BadRequestException(
          'فرمت فایل مجاز نیست. فقط jpeg, png, webp',
        );
      }
      if (file.size > this.maxSize) {
        throw new BadRequestException(
          `حجم فایل نباید بیشتر از ${this.maxSize / (1024 * 1024)}MB باشد`,
        );
      }
    }

    return files;
  }
}
