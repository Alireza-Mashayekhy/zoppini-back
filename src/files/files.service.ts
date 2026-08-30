// src/files/files.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class FilesService {
  saveFile(file: Express.Multer.File) {
    if (!file || !file.buffer) {
      throw new Error('فایل معتبر نیست');
    }

    // ۱. تولید نام یکتا برای فایل
    const ext = path.extname(file.originalname || '');

    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];
    if (!allowedExts.includes(ext))
      throw new BadRequestException('فرمت فایل مجاز نیست');

    const filename = `${uuidv4()}${ext}`;

    // ۲. مسیر کامل دایرکتوری uploads (در ریشه پروژه)
    const uploadDir = path.join(process.cwd(), 'uploads');

    // ۳. ایجاد دایرکتوری در صورت نبود
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // ۴. مسیر کامل فایل
    const filePath = path.join(uploadDir, filename);

    // ۵. ذخیره فایل
    fs.writeFileSync(filePath, file.buffer);

    return {
      message: 'File uploaded successfully!',
      filename,
    };
  }

  deleteFile(filename: string) {
    if (!filename) {
      return {
        success: false,
        message: 'Filename is empty',
      };
    }

    const filePath = path.join(process.cwd(), 'uploads', filename);

    try {
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          message: 'File not found',
        };
      }

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
