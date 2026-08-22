import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FilesService } from 'src/files/files.service';
import { DataSource, MoreThanOrEqual, Repository } from 'typeorm';

import { Catalog } from './entities/catalog.entity';

@Injectable()
export class CatalogService {
  constructor(
    @InjectRepository(Catalog)
    private readonly catalogPageRepository: Repository<Catalog>,

    private readonly dataSource: DataSource,

    private readonly filesService: FilesService,
  ) {}

  // =========================
  // GET
  // =========================

  async getPages() {
    const pages = await this.catalogPageRepository.find({
      order: {
        pageNumber: 'ASC',
      },
    });

    return pages.map(page => ({
      id: page.id,
      image: `/uploads/${page.image}`,
      pageNumber: page.pageNumber,
    }));
  }

  // =========================
  // CREATE
  // =========================

  async createPage(pageNumber: number, file: Express.Multer.File) {
    if (!pageNumber || pageNumber < 1) {
      throw new BadRequestException('شماره صفحه معتبر نیست');
    }

    const uploadedFile = this.filesService.saveFile(file);

    try {
      return await this.dataSource.transaction(async manager => {
        const repository = manager.getRepository(Catalog);

        /**
         * همه صفحات از این صفحه به بعد
         * یک شماره جلو می‌روند.
         *
         * DESC خیلی مهم است.
         */
        const pages = await repository.find({
          where: {
            pageNumber: MoreThanOrEqual(pageNumber),
          },
          order: {
            pageNumber: 'DESC',
          },
        });

        for (const page of pages) {
          page.pageNumber += 1;

          await repository.save(page);
        }

        const newPage = repository.create({
          pageNumber,
          image: uploadedFile.filename,
        });

        return repository.save(newPage);
      });
    } catch (error) {
      // اگر DB شکست خورد، فایل orphan نشود
      this.filesService.deleteFile(uploadedFile.filename);

      throw error;
    }
  }

  // =========================
  // UPDATE
  // =========================

  async updatePage(id: string, file: Express.Multer.File) {
    const page = await this.catalogPageRepository.findOne({
      where: { id },
    });

    if (!page) {
      throw new NotFoundException('صفحه کاتالوگ پیدا نشد');
    }

    const oldFilename = page.image;

    const uploadedFile = this.filesService.saveFile(file);

    try {
      page.image = uploadedFile.filename;

      const updated = await this.catalogPageRepository.save(page);

      /**
       * فایل قبلی را بعد از موفقیت DB حذف می‌کنیم.
       */
      this.filesService.deleteFile(oldFilename);

      return {
        id: updated.id,
        image: `/uploads/${updated.image}`,
        pageNumber: updated.pageNumber,
      };
    } catch (error) {
      /**
       * اگر DB شکست خورد، فایل جدید را پاک کن.
       */
      this.filesService.deleteFile(uploadedFile.filename);

      throw error;
    }
  }

  // =========================
  // DELETE
  // =========================

  async deletePage(id: string) {
    return this.dataSource.transaction(async manager => {
      const repository = manager.getRepository(Catalog);

      const page = await repository.findOne({
        where: { id },
      });

      if (!page) {
        throw new NotFoundException('صفحه کاتالوگ پیدا نشد');
      }

      const deletedPageNumber = page.pageNumber;

      const deletedFilename = page.image;

      /**
       * ابتدا صفحه را حذف می‌کنیم.
       */
      await repository.remove(page);

      /**
       * صفحات بعدی یک واحد عقب می‌آیند.
       */
      const pages = await repository.find({
        where: {
          pageNumber: MoreThanOrEqual(deletedPageNumber + 1),
        },
        order: {
          pageNumber: 'ASC',
        },
      });

      for (const page of pages) {
        page.pageNumber -= 1;

        await repository.save(page);
      }

      /**
       * فایل را بعد از حذف موفق DB پاک می‌کنیم.
       */
      this.filesService.deleteFile(deletedFilename);

      return {
        success: true,
        message: 'صفحه کاتالوگ با موفقیت حذف شد',
      };
    });
  }
}
