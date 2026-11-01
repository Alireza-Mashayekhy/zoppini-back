jest.mock('uuid', () => ({ v4: () => 'test-id' }));

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { SiteImage } from './entities/site-image.entity';
import { SiteImagesService } from './site-images.service';

/**
 * منطق ذخیره‌ی تصاویر صفحه اصلی:
 * - تصویر دسکتاپ برای بار اول الزامی است
 * - تصویر موبایل اختیاری است (خالی = همان دسکتاپ)
 * - فایل قبلی فقط بعد از ذخیره‌ی موفق حذف می‌شود
 */
describe('SiteImagesService', () => {
  function file(name: string) {
    return {
      originalname: name,
      buffer: Buffer.from('x'),
      size: 10,
      mimetype: 'image/webp',
    } as Express.Multer.File;
  }

  function setup(existing: Partial<SiteImage> | null = null) {
    const repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(existing),
      create: jest.fn((value: Partial<SiteImage>) => value),
      save: jest.fn((value: Partial<SiteImage>) => ({
        id: 1,
        isActive: true,
        updatedAt: new Date(),
        ...value,
      })),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    let fileCounter = 0;

    const filesService = {
      save: jest.fn(() => ({
        filename: `saved-${++fileCounter}.webp`,
        url: `saved-${fileCounter}.webp`,
      })),
      deleteFile: jest.fn().mockReturnValue({ success: true }),
    };

    const service = Object.create(
      SiteImagesService.prototype,
    ) as SiteImagesService;

    Object.assign(service, { siteImageRepo: repo, filesService });

    return { service, repo, filesService };
  }

  it('rejects an unknown slot', async () => {
    const { service } = setup();

    await expect(service.upsert('home.unknown', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('requires a desktop image the first time', async () => {
    const { service, repo } = setup(null);

    await expect(service.upsert('home.sale-banner', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('saves only the desktop image and leaves mobile empty (optional)', async () => {
    const { service, repo } = setup(null);

    const result = await service.upsert(
      'home.sale-banner',
      { alt: '  بنر فروش ویژه  ', linkUrl: '/products' },
      { desktop: file('desktop.webp') },
    );

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'home.sale-banner',
        desktopImage: 'saved-1.webp',
        alt: 'بنر فروش ویژه',
        linkUrl: '/products',
      }),
    );

    // تصویر موبایل ارسال نشده است → همان دسکتاپ روی موبایل استفاده می‌شود
    expect(result.mobile).toBeNull();
    expect(result.desktop).toBe('saved-1.webp');
  });

  it('stores both images and deletes the replaced desktop file', async () => {
    const { service, filesService } = setup({
      id: 4,
      slot: 'home.sale-banner',
      desktopImage: 'old-desktop.webp',
      mobileImage: null,
      alt: null,
      linkUrl: null,
      isActive: true,
    });

    await service.upsert(
      'home.sale-banner',
      {},
      { desktop: file('d.webp'), mobile: file('m.webp') },
    );

    expect(filesService.deleteFile).toHaveBeenCalledWith('old-desktop.webp');
    expect(filesService.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('removes the mobile image on request and falls back to desktop', async () => {
    const { service, repo, filesService } = setup({
      id: 4,
      slot: 'home.sale-banner',
      desktopImage: 'desktop.webp',
      mobileImage: 'mobile.webp',
      alt: null,
      linkUrl: null,
      isActive: true,
    });

    await service.upsert('home.sale-banner', { removeMobile: true });

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ mobileImage: null }),
    );

    expect(filesService.deleteFile).toHaveBeenCalledWith('mobile.webp');
  });

  it('rejects uploading and removing the mobile image at the same time', async () => {
    const { service } = setup({ id: 4, slot: 'home.sale-banner' });

    await expect(
      service.upsert(
        'home.sale-banner',
        { removeMobile: true },
        { mobile: file('m.webp') },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not delete old files when saving fails', async () => {
    const { service, repo, filesService } = setup({
      id: 4,
      slot: 'home.sale-banner',
      desktopImage: 'old.webp',
      mobileImage: null,
      alt: null,
      linkUrl: null,
      isActive: true,
    });

    repo.save.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.upsert('home.sale-banner', {}, { desktop: file('new.webp') }),
    ).rejects.toThrow('db down');

    expect(filesService.deleteFile).toHaveBeenCalledWith('saved-1.webp');
    expect(filesService.deleteFile).not.toHaveBeenCalledWith('old.webp');
  });

  it('resets a slot: deletes the record and its files', async () => {
    const { service, repo, filesService } = setup({
      id: 4,
      slot: 'home.sale-banner',
      desktopImage: 'desktop.webp',
      mobileImage: 'mobile.webp',
    });

    await service.reset('home.sale-banner');

    expect(repo.remove).toHaveBeenCalled();
    expect(filesService.deleteFile).toHaveBeenCalledWith('desktop.webp');
    expect(filesService.deleteFile).toHaveBeenCalledWith('mobile.webp');
  });

  it('throws when resetting a slot that has nothing uploaded', async () => {
    const { service } = setup(null);

    await expect(service.reset('home.sale-banner')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('only exposes active slots with a desktop image to the site', async () => {
    const { service, repo } = setup();

    repo.find.mockResolvedValueOnce([
      {
        slot: 'home.sale-banner',
        desktopImage: 'desktop.webp',
        mobileImage: null,
        alt: 'بنر',
        linkUrl: '/products',
        isActive: true,
      },
      {
        slot: 'home.category-1',
        desktopImage: null,
        mobileImage: null,
        alt: null,
        linkUrl: null,
        isActive: true,
      },
    ]);

    const result = await service.findActive();

    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );

    expect(result).toEqual([
      {
        slot: 'home.sale-banner',
        desktop: 'desktop.webp',
        mobile: null,
        alt: 'بنر',
        linkUrl: '/products',
      },
    ]);
  });
});
