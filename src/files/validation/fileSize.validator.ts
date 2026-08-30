import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class FileSizeValidationPipe implements PipeTransform {
  private readonly maxSize = 1024 * 1024 * 2; //2 MB
  private readonly allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];

  transform(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('فایل آپلود نشده است.');
    }

    if (file.size > this.maxSize) {
      throw new BadRequestException(
        `حجم فایل نباید بیشتر از . ${this.maxSize / (1024 * 1024)}MB باشید`,
      );
    }

    if (!this.allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException('فرمت فایل مجاز نیست. فقط jpeg, png, webp');
    }

    return file;
  }
}
