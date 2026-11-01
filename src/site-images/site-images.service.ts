import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FilesService } from 'src/files/files.service';
import { Repository } from 'typeorm';

import { UpdateSiteImageDto } from './dto/update-site-image.dto';
import { SiteImage } from './entities/site-image.entity';
import { isKnownSiteImageSlot } from './site-image-slots';

/** تصویری که سایت می‌خواند (فقط جایگاه‌های فعال) */
export interface PublicSiteImage {
  /** کلید جایگاه (مثل `home.sale-banner`) */
  slot: string;
  /** نام فایل تصویر دسکتاپ؛ فرانت با NEXT_PUBLIC_IMAGE_URL کاملش می‌کند */
  desktop: string | null;
  /** نام فایل تصویر موبایل؛ `null` یعنی همان تصویر دسکتاپ استفاده شود */
  mobile: string | null;
  alt: string | null;
  linkUrl: string | null;
}

/** همان تصویر + وضعیت، برای پنل مدیریت */
export interface AdminSiteImageView extends PublicSiteImage {
  isActive: boolean;
  updatedAt: Date | null;
}

export interface SiteImageFiles {
  desktop?: Express.Multer.File;
  mobile?: Express.Multer.File;
}

@Injectable()
export class SiteImagesService {
  private readonly logger = new Logger(SiteImagesService.name);

  constructor(
    @InjectRepository(SiteImage)
    private readonly siteImageRepo: Repository<SiteImage>,
    private readonly filesService: FilesService,
  ) {}

  // ============================================================
  // خواندن (سایت)
  // ============================================================

  /**
   * تصاویری که باید روی سایت نمایش داده شوند.
   *
   * جایگاه‌های خاموش برنمی‌گردند تا فرانت‌اند برایشان تصویر پیش‌فرض
   * خودش را نشان دهد.
   */
  async findActive(): Promise<PublicSiteImage[]> {
    const images = await this.siteImageRepo.find({
      where: { isActive: true },
      order: { id: 'ASC' },
    });

    return images
      .filter(image => Boolean(image.desktopImage))
      .map(image => this.toPublicView(image));
  }

  // ============================================================
  // خواندن (پنل مدیریت)
  // ============================================================

  /** همه‌ی جایگاه‌های ذخیره‌شده، حتی خاموش‌ها */
  async findAll(): Promise<AdminSiteImageView[]> {
    const images = await this.siteImageRepo.find({ order: { id: 'ASC' } });

    return images.map(image => ({
      ...this.toPublicView(image),
      isActive: image.isActive,
      updatedAt: image.updatedAt ?? null,
    }));
  }

  // ============================================================
  // ذخیره
  // ============================================================

  /**
   * ساخت یا به‌روزرسانی تصویر یک جایگاه.
   *
   * - تصویر دسکتاپ برای اولین بار الزامی است.
   * - تصویر موبایل اختیاری است؛ اگر ارسال نشود، `mobile` خالی می‌ماند و
   *   سایت روی موبایل همان تصویر دسکتاپ را نشان می‌دهد.
   * - فایل قبلی فقط بعد از ذخیره‌ی موفق رکورد حذف می‌شود تا اگر خطایی
   *   رخ داد، تصویر فعلی سایت از دست نرود.
   */
  async upsert(
    slot: string,
    dto: UpdateSiteImageDto,
    files: SiteImageFiles = {},
  ): Promise<AdminSiteImageView> {
    this.assertKnownSlot(slot);

    const existing = await this.siteImageRepo.findOne({ where: { slot } });

    const hasNewDesktop = Boolean(files.desktop);
    const hasNewMobile = Boolean(files.mobile);
    const removeMobile = dto.removeMobile === true;

    if (hasNewMobile && removeMobile) {
      throw new BadRequestException(
        'هم‌زمان نمی‌توان تصویر موبایل را حذف و آپلود کرد',
      );
    }

    if (!existing && !hasNewDesktop) {
      throw new BadRequestException(
        'برای این جایگاه ابتدا باید تصویر دسکتاپ را آپلود کنید؛ تصویر موبایل اختیاری است',
      );
    }

    // فایل‌های جدید ابتدا روی دیسک ذخیره می‌شوند
    const newDesktop = files.desktop
      ? this.filesService.save(files.desktop, 'image').filename
      : null;

    const newMobile = files.mobile
      ? this.filesService.save(files.mobile, 'image').filename
      : null;

    const previousDesktop = existing?.desktopImage ?? null;
    const previousMobile = existing?.mobileImage ?? null;

    const image = existing ?? this.siteImageRepo.create({ slot });

    if (newDesktop) {
      image.desktopImage = newDesktop;
    }

    if (newMobile) {
      image.mobileImage = newMobile;
    } else if (removeMobile) {
      image.mobileImage = null;
    }

    if (dto.alt !== undefined) {
      image.alt = dto.alt.trim() || null;
    }

    if (dto.linkUrl !== undefined) {
      image.linkUrl = dto.linkUrl.trim() || null;
    }

    if (dto.isActive !== undefined) {
      image.isActive = dto.isActive;
    }

    let saved: SiteImage;

    try {
      saved = await this.siteImageRepo.save(image);
    } catch (error) {
      // فایل‌های تازه‌ذخیره‌شده orphan نمانند
      if (newDesktop) this.filesService.deleteFile(newDesktop);
      if (newMobile) this.filesService.deleteFile(newMobile);

      throw error;
    }

    // حالا که رکورد ذخیره شده، فایل‌های جایگزین‌شده پاک می‌شوند
    if (newDesktop && previousDesktop) {
      this.safeDelete(previousDesktop);
    }

    if ((newMobile || removeMobile) && previousMobile) {
      this.safeDelete(previousMobile);
    }

    return {
      ...this.toPublicView(saved),
      isActive: saved.isActive,
      updatedAt: saved.updatedAt ?? null,
    };
  }

  // ============================================================
  // حذف / بازگشت به پیش‌فرض
  // ============================================================

  /**
   * پاک‌کردن تصویر آپلودی یک جایگاه تا سایت به تصویر پیش‌فرض خودش برگردد.
   */
  async reset(slot: string) {
    this.assertKnownSlot(slot);

    const existing = await this.siteImageRepo.findOne({ where: { slot } });

    if (!existing) {
      throw new NotFoundException('برای این جایگاه تصویری آپلود نشده است');
    }

    await this.siteImageRepo.remove(existing);

    if (existing.desktopImage) {
      this.safeDelete(existing.desktopImage);
    }

    if (existing.mobileImage) {
      this.safeDelete(existing.mobileImage);
    }

    return {
      message: 'تصویر جایگاه حذف شد و تصویر پیش‌فرض سایت برگشت',
      slot,
    };
  }

  // ============================================================
  // کمکی
  // ============================================================

  private assertKnownSlot(slot: string) {
    if (!isKnownSiteImageSlot(slot)) {
      throw new BadRequestException(`جایگاه تصویر «${slot}» شناخته نمی‌شود`);
    }
  }

  private toPublicView(image: SiteImage): PublicSiteImage {
    return {
      slot: image.slot,
      desktop: image.desktopImage ?? null,
      mobile: image.mobileImage ?? null,
      alt: image.alt ?? null,
      linkUrl: image.linkUrl ?? null,
    };
  }

  /** حذف فایل جایگزین‌شده نباید ذخیره‌ی موفق را خراب کند */
  private safeDelete(filename: string) {
    try {
      this.filesService.deleteFile(filename);
    } catch (error) {
      this.logger.warn(
        `حذف فایل قدیمی تصویر (${filename}) انجام نشد: ${(error as Error).message}`,
      );
    }
  }
}
