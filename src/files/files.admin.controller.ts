import {
  BadRequestException,
  Controller,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage, memoryStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { AuthGuard } from 'src/common/guards/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';

import { FilesService } from './files.service';
import {
  allowedExtensionsLabel,
  UPLOAD_PRESETS,
  UploadKind,
} from './upload-presets';
import { FileSizeArrayValidationPipe } from './validation/fileSizeArray.validator';

const imagePreset = UPLOAD_PRESETS.image;
const videoPreset = UPLOAD_PRESETS.video;
const audioPreset = UPLOAD_PRESETS.audio;

/**
 * ویدیوها به‌جای رم، مستقیم روی دیسک نوشته می‌شوند تا آپلود ۵۰ مگابایتی
 * حافظه‌ی سرور را درگیر نکند. اعتبارسنجی نوع فایل هم قبل از نوشتن انجام
 * می‌شود (fileFilter) تا فایل نامعتبر روی دیسک ننشیند.
 */
const videoStorage = diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.cwd(), 'uploads', 'videos');

    try {
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (error) {
      cb(error as Error, dir);
    }
  },

  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

function videoFileFilter(
  _req: unknown,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();

  const isAllowedExt = videoPreset.extensions.includes(ext);

  const isAllowedMime =
    !mime || mime === 'application/octet-stream' || videoPreset.mimes.includes(mime);

  if (!isAllowedExt || !isAllowedMime) {
    cb(
      new BadRequestException(
        `فرمت ویدیو مجاز نیست. فرمت‌های مجاز: ${allowedExtensionsLabel(videoPreset)}`,
      ),
      false,
    );
    return;
  }

  cb(null, true);
}

interface UploadedFileResult {
  filename: string;
  url: string;
  kind: UploadKind;
}

@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.Admin, Role.Seo)
@Controller('admin/files')
export class FilesAdminController {
  constructor(private readonly filesService: FilesService) {}

  /** آپلود تصویر (چندتایی) برای ادیتور متن، گالری مدیا و کاور */
  @Post('image')
  @UseInterceptors(
    FilesInterceptor('images', 20, {
      storage: memoryStorage(),
      limits: { fileSize: imagePreset.maxSize },
    }),
  )
  uploadImages(
    @UploadedFiles(new FileSizeArrayValidationPipe({ kind: 'image' }))
    files: Express.Multer.File[],
  ) {
    const saved = files.map(file => {
      const result = this.filesService.save(file, 'image');
      return {
        filename: result.filename,
        url: result.url,
        kind: 'image' as UploadKind,
      };
    });

    return this.buildResponse(saved);
  }

  /** آپلود ویدیو (چندتایی) — ذخیره‌ی مستقیم روی دیسک */
  @Post('video')
  @UseInterceptors(
    FilesInterceptor('videos', 5, {
      storage: videoStorage,
      fileFilter: videoFileFilter,
      limits: { fileSize: videoPreset.maxSize },
    }),
  )
  uploadVideos(
    @UploadedFiles(new FileSizeArrayValidationPipe({ kind: 'video' }))
    files: Express.Multer.File[],
  ) {
    const saved: UploadedFileResult[] = files.map(file => ({
      filename: file.filename,
      url: `videos/${file.filename}`,
      kind: 'video' as UploadKind,
    }));

    return this.buildResponse(saved);
  }

  /** آپلود فایل صوتی (چندتایی) — ادیتور متن دکمه‌ی صوت هم دارد */
  @Post('audio')
  @UseInterceptors(
    FilesInterceptor('audios', 10, {
      storage: memoryStorage(),
      limits: { fileSize: audioPreset.maxSize },
    }),
  )
  uploadAudios(
    @UploadedFiles(new FileSizeArrayValidationPipe({ kind: 'audio' }))
    files: Express.Multer.File[],
  ) {
    const saved = files.map(file => {
      const result = this.filesService.save(file, 'audio');
      return {
        filename: result.filename,
        url: result.url,
        kind: 'audio' as UploadKind,
      };
    });

    return this.buildResponse(saved);
  }

  /**
   * خروجی یکسان برای همه‌ی آپلودها:
   * `url` و `filename` اولین فایل (چون ادیتور nilfam فقط یک url می‌خواند)
   * و لیست کامل در `urls` / `filenames` / `files`.
   */
  private buildResponse(files: UploadedFileResult[]) {
    if (files.length === 0) {
      throw new BadRequestException('فایل آپلود نشده است.');
    }

    return {
      message: 'فایل با موفقیت آپلود شد',
      filename: files[0].filename,
      url: files[0].url,
      filenames: files.map(file => file.filename),
      urls: files.map(file => file.url),
      files,
    };
  }
}
