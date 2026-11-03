jest.mock('uuid', () => ({ v4: () => 'test-id' }));

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryRunner } from 'typeorm';

import dataSource from '../common/config/typeorm-care-title-datasource';
import { ProductCareInstructionsTitle1799000000000 } from '../migrations/1799000000000-ProductCareInstructionsTitle';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CareInstructionsTitle } from './entities/product.entity';
import { ProductsService } from './products.service';

const careErrors = async (dto: object) =>
  (await validate(dto)).filter(e => e.property === 'careInstructionsTitle');

describe('product care instructions title', () => {
  it('accepts both options and rejects other values on create and update', async () => {
    for (const Dto of [CreateProductDto, UpdateProductDto]) {
      for (const title of ['washing', 'maintenance', undefined]) {
        expect(
          await careErrors(
            plainToInstance(Dto, { careInstructionsTitle: title }),
          ),
        ).toHaveLength(0);
      }
      expect(
        await careErrors(
          plainToInstance(Dto, { careInstructionsTitle: 'other' }),
        ),
      ).toHaveLength(1);
    }
  });

  it('persists the chosen title on create and defaults old clients to washing', async () => {
    const productRepo = {
      create: jest.fn(value => value),
      save: jest.fn(value => Promise.resolve(value)),
      findOneOrFail: jest.fn().mockResolvedValue({}),
    };
    const service = Object.create(ProductsService.prototype) as ProductsService;
    Object.assign(service, { productRepo });
    await service.create({
      title: 'leather',
      careInstructionsTitle: CareInstructionsTitle.MAINTENANCE,
    } as CreateProductDto);
    expect(productRepo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ careInstructionsTitle: 'maintenance' }),
    );
    await service.create({ title: 'shirt' } as CreateProductDto);
    expect(productRepo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ careInstructionsTitle: 'washing' }),
    );
  });

  it('updates the title without clearing it when omitted', async () => {
    const product = {
      id: 1,
      productCode: 'P1',
      image: null,
      careInstructionsTitle: 'maintenance',
    };
    const manager = {
      save: jest.fn(value => Promise.resolve(value)),
      findOneOrFail: jest.fn().mockResolvedValue(product),
    };
    const runner = {
      manager,
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
    };
    const service = Object.create(ProductsService.prototype) as ProductsService;
    Object.assign(service, {
      productRepo: { findOne: jest.fn().mockResolvedValue(product) },
      dataSource: { createQueryRunner: () => runner },
    });
    await service.update(1, { title: 'updated' });
    expect(product.careInstructionsTitle).toBe('maintenance');
    await service.update(1, {
      careInstructionsTitle: CareInstructionsTitle.WASHING,
    });
    expect(product.careInstructionsTitle).toBe('washing');
  });

  it('adds a defaulted column without rewriting existing care text', async () => {
    const migration = new ProductCareInstructionsTitle1799000000000();
    const q = {
      hasTable: jest.fn().mockResolvedValue(true),
      hasColumn: jest.fn().mockResolvedValue(false),
      addColumn: jest.fn(),
      dropColumn: jest.fn(),
    };
    await migration.up(q as unknown as QueryRunner);
    expect(q.addColumn).toHaveBeenCalledWith(
      'product',
      expect.objectContaining({
        name: 'careInstructionsTitle',
        default: "'washing'",
        isNullable: false,
      }),
    );
    q.hasColumn.mockResolvedValue(true);
    await migration.up(q as unknown as QueryRunner);
    expect(q.addColumn).toHaveBeenCalledTimes(1);
    await migration.down(q as unknown as QueryRunner);
    expect(q.dropColumn).toHaveBeenCalledWith(
      'product',
      'careInstructionsTitle',
    );
  });
});

describe('isolated care title migration datasource', () => {
  it('uses only the intended migration and disables automatic schema changes', () => {
    expect(dataSource.options.migrations).toEqual([
      ProductCareInstructionsTitle1799000000000,
    ]);
    expect(dataSource.options.migrationsRun).toBe(false);
    expect(dataSource.options.synchronize).toBe(false);
  });
});
