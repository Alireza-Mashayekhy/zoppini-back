import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { PageSeo } from './entities/page-seo.entity';
import { DEFAULT_PAGES_SEO } from './seo.constants';
import { SeoService } from './seo.service';

type MockRepository = Partial<Record<keyof Repository<PageSeo>, jest.Mock>>;

function createMockRepository(): MockRepository {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

describe('SeoService', () => {
  let service: SeoService;
  let repository: MockRepository;

  beforeEach(() => {
    repository = createMockRepository();

    service = new SeoService(repository as unknown as Repository<PageSeo>);
  });

  describe('findByPath', () => {
    it('مسیر را نرمال می‌کند (اسلش ابتدایی و انتهایی)', async () => {
      repository.findOne!.mockResolvedValue(null);

      await service.findByPath('about-us/');

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { path: '/about-us' },
      });
    });

    it('برای مسیر خالی null برمی‌گرداند', async () => {
      await expect(service.findByPath('')).resolves.toBeNull();
      expect(repository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('اگر مسیر تکراری باشد خطای تداخل می‌دهد', async () => {
      repository.findOne!.mockResolvedValue({ id: 1, path: '/about-us' });

      await expect(
        service.create({ path: 'about-us', metaTitle: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('مقدارهای خالی را با رشته‌ی خالی ذخیره می‌کند', async () => {
      repository.findOne!.mockResolvedValue(null);
      repository.create!.mockImplementation((value: Partial<PageSeo>) => value);
      repository.save!.mockImplementation((value: PageSeo) => value);

      const result = await service.create({
        path: '/new-page',
        label: 'صفحه جدید',
      });

      expect(repository.create).toHaveBeenCalledWith({
        path: '/new-page',
        label: 'صفحه جدید',
        metaTitle: '',
        metaDescription: '',
      });
      expect(result.path).toBe('/new-page');
    });
  });

  describe('update', () => {
    it('متا تایتل و دیسکریپشن را به‌روزرسانی می‌کند', async () => {
      repository.findOne!.mockResolvedValue({
        id: 2,
        path: '/about-us',
        metaTitle: 'قدیمی',
        metaDescription: '',
      });
      repository.save!.mockImplementation((value: PageSeo) => value);

      const result = await service.update(2, {
        metaTitle: 'جدید',
        metaDescription: 'توضیح جدید',
      });

      expect(result.metaTitle).toBe('جدید');
      expect(result.metaDescription).toBe('توضیح جدید');
    });

    it('برای شناسه‌ی ناموجود خطا می‌دهد', async () => {
      repository.findOne!.mockResolvedValue(null);

      await expect(service.update(999, { metaTitle: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('onModuleInit', () => {
    it('فقط صفحاتی را می‌سازد که از قبل وجود ندارند', async () => {
      repository.find!.mockResolvedValue([{ path: '/' }]);
      repository.create!.mockImplementation((value: unknown) => value);
      repository.save!.mockResolvedValue([]);

      await service.onModuleInit();

      const saved = repository.save!.mock.calls[0][0] as PageSeo[];

      expect(saved).toHaveLength(DEFAULT_PAGES_SEO.length - 1);
      expect(saved.map(page => page.path)).not.toContain('/');
    });

    it('اگر همه‌ی صفحات وجود داشته باشند چیزی ذخیره نمی‌کند', async () => {
      repository.find!.mockResolvedValue(
        DEFAULT_PAGES_SEO.map(page => ({ path: page.path })),
      );

      await service.onModuleInit();

      expect(repository.save).not.toHaveBeenCalled();
    });
  });
});
