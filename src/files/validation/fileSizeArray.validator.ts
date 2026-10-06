import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { Express } from 'express';
import * as path from 'path';

import {
  allowedExtensionsLabel,
  UPLOAD_PRESETS,
  UploadKind,
} from '../upload-presets';

export interface FileSizeArrayValidationOptions {
  kind?: UploadKind;
  optional?: boolean;
}

@Injectable()
export class FileSizeArrayValidationPipe implements PipeTransform {
  private readonly preset;
  private readonly optional: boolean;

  constructor(private readonly options: FileSizeArrayValidationOptions = {}) {
    this.preset = UPLOAD_PRESETS[options.kind ?? 'image'];
    this.optional = options.optional ?? false;
  }

  transform(files: Express.Multer.File[]) {
    if (!files || !Array.isArray(files) || files.length === 0) {
      if (this.optional) {
        return [];
      }

      throw new BadRequestException('هیچ فایلی ارسال نشده است.');
    }

    for (const file of files) {
      if (!file) continue;

      const ext = path.extname(file.originalname || '').toLowerCase();

      if (!this.preset.extensions.includes(ext)) {
        throw new BadRequestException(
          `فرمت فایل مجاز نیست. فرمت‌های مجاز: ${allowedExtensionsLabel(this.preset)}`,
        );
      }

      const mime = (file.mimetype || '').toLowerCase();
      if (
        mime &&
        mime !== 'application/octet-stream' &&
        !this.preset.mimes.includes(mime)
      ) {
        throw new BadRequestException(
          `فرمت فایل مجاز نیست. فرمت‌های مجاز: ${allowedExtensionsLabel(this.preset)}`,
        );
      }

      if (file.size > this.preset.maxSize) {
        throw new BadRequestException(
          `حجم ${this.preset.label} نباید بیشتر از ${this.preset.maxSize / (1024 * 1024)}MB باشد`,
        );
      }
    }

    return files;
  }
}
