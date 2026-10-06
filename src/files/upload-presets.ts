/**
 * تنظیمات مشترک انواع فایل آپلودی.
 *
 * هم سرویس ذخیره‌سازی (FilesService) و هم پایپ‌های اعتبارسنجی از همین
 * منبع استفاده می‌کنند تا محدودیت حجم/فرمت در یک جا تعریف شده باشد.
 */
export type UploadKind = 'image' | 'video' | 'audio';

export interface UploadPreset {
  /** حداکثر حجم مجاز به بایت */
  maxSize: number;
  /** پسوندهای مجاز (کوچک‌نویس) */
  extensions: string[];
  /** mime typeهای مجاز */
  mimes: string[];
  /** برچسب فارسی برای پیام‌های خطا */
  label: string;
}

export const MB = 1024 * 1024;

export const UPLOAD_PRESETS: Record<UploadKind, UploadPreset> = {
  image: {
    maxSize: 5 * MB,
    extensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'],
    mimes: [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/avif',
    ],
    label: 'تصویر',
  },
  video: {
    /**
     * ویدیوها مستقیماً (بدون ترنسکد) سرو می‌شوند؛ برای اینکه سرور و
     * کاربر اذیت نشوند سقف ۵۰ مگابایت گذاشته شده است.
     * (ویدیوهای سنگین‌تر باید مثل ویدیوهای صفحه اصلی به HLS تبدیل شوند.)
     */
    maxSize: 50 * MB,
    extensions: ['.mp4', '.webm', '.ogv', '.m4v'],
    mimes: ['video/mp4', 'video/webm', 'video/ogg', 'video/x-m4v'],
    label: 'ویدیو',
  },
  audio: {
    maxSize: 10 * MB,
    extensions: ['.mp3', '.m4a', '.wav', '.ogg', '.aac'],
    mimes: [
      'audio/mpeg',
      'audio/mp3',
      'audio/mp4',
      'audio/x-m4a',
      'audio/wav',
      'audio/x-wav',
      'audio/ogg',
      'audio/aac',
    ],
    label: 'فایل صوتی',
  },
};

/** پیام فرمت‌های مجاز مثل «jpg، png، webp» */
export function allowedExtensionsLabel(preset: UploadPreset): string {
  return preset.extensions.map(ext => ext.replace('.', '')).join('، ');
}
