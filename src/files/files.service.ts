// src/files/files.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

import {
  allowedExtensionsLabel,
  UPLOAD_PRESETS,
  UploadKind,
} from './upload-presets';

/** پوشه‌ی هر نوع فایل داخل uploads (برای مرتب ماندن فایل‌ها) */
const KIND_FOLDERS: Record<UploadKind, string> = {
  image: 'images',
  video: 'videos',
  audio: 'audios',
};

export interface SavedFile {
  filename: string;
  url: string;
  kind: UploadKind;
  size: number;
}

@Injectable()
export class FilesService {
  saveFile(file: Express.Multer.File, kind: UploadKind = 'image') {
    const saved = this.save(file, kind);

    return {
      message: 'File uploaded successfully!',
      filename: saved.filename,
      url: saved.url,
    };
  }

  /**
   * ذخیره‌ی فایل روی دیسک و برگرداندن «نام فایل» (نسبی).
   *
   * نام نسبی ذخیره می‌شود چون دامنه‌ی سرو فایل‌ها ممکن است بین محیط‌ها
   * تغییر کند (local / production)؛ فرانت با NEXT_PUBLIC_IMAGE_URL
   * آدرس کامل را می‌سازد.
   */
  save(file: Express.Multer.File, kind: UploadKind = 'image'): SavedFile {
    if (!file || !file.buffer) {
      throw new BadRequestException('فایل معتبر نیست');
    }

    const preset = UPLOAD_PRESETS[kind];

    const ext = path.extname(file.originalname || '').toLowerCase();

    if (!preset.extensions.includes(ext)) {
      throw new BadRequestException(
        `فرمت فایل مجاز نیست. فرمت‌های مجاز: ${allowedExtensionsLabel(preset)}`,
      );
    }

    if (file.size > preset.maxSize) {
      throw new BadRequestException(
        `حجم ${preset.label} نباید بیشتر از ${preset.maxSize / (1024 * 1024)}MB باشد`,
      );
    }

    const filename = `${uuidv4()}${ext}`;

    // مسیر کامل دایرکتوری uploads (در ریشه پروژه)
    const uploadDir = path.join(process.cwd(), 'uploads', KIND_FOLDERS[kind]);

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    fs.writeFileSync(path.join(uploadDir, filename), file.buffer);

    return {
      filename,
      /** مسیر نسبی از ریشه‌ی uploads — همان چیزی که در دیتابیس ذخیره می‌شود */
      url: `${KIND_FOLDERS[kind]}/${filename}`,
      kind,
      size: file.size,
    };
  }

  /**
   * حذف فایل با «نام نسبی» (مثل images/xxx.webp) یا نام قدیمی بدون پوشه
   * (سازگار با رکوردهای قبلی که مستقیم در ریشه‌ی uploads بودند).
   */
  deleteFile(filename: string) {
    if (!filename) {
      return {
        success: false,
        message: 'Filename is empty',
      };
    }

    const relative = filename.replace(/^\/+/, '');

    const candidates = [
      path.join(process.cwd(), 'uploads', relative),
      path.join(process.cwd(), 'uploads', path.basename(relative)),
    ];

    const filePath = candidates.find(candidate => fs.existsSync(candidate));

    if (!filePath) {
      return {
        success: false,
        message: 'File not found',
      };
    }

    try {
      fs.unlinkSync(filePath);

      return {
        success: true,
        message: 'File deleted successfully',
      };
    } catch (error) {
      console.error(`Failed to delete file: ${filename}`, error);

      return {
        success: false,
        message: 'Failed to delete file',
      };
    }
  }
}
