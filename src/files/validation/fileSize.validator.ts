import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class FileSizeValidationPipe implements PipeTransform {
  private readonly maxSize = 1024 * 1024 * 2; //2 MB

  transform(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('فایل آپلود نشده است.');
    }

    if (file.size > this.maxSize) {
      throw new BadRequestException(
        `حجم فایل نباید بیشتر از . ${this.maxSize / (1024 * 1024)}MB باشید`,
      );
    }

    return file;
  }
}
