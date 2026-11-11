import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ResponseInterceptor } from 'src/common/interceptors/response.interceptor';
import { PromotionsService } from 'src/promotions/promotions.service';
import request from 'supertest';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

describe('GET /api/products', () => {
  let app: INestApplication;
  const getActivePrepared = jest.fn();
  const qb: any = {};
  const product = {
    id: 7,
    title: 'پیراهن',
    slug: 'shirt',
    categories: [],
    variants: [{ id: 1, price: 100000, stock: 4 }],
  };

  beforeAll(async () => {
    for (const method of [
      'leftJoinAndSelect',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
    ]) {
      qb[method] = jest.fn().mockReturnValue(qb);
    }
    qb.getManyAndCount = jest.fn();
    const promotions = Object.create(PromotionsService.prototype);
    Object.assign(promotions, { promotionsRepository: { getActivePrepared } });
    const service = Object.create(ProductsService.prototype);
    Object.assign(service, {
      productRepo: { createQueryBuilder: () => qb },
      discountsService: {
        getActiveSales: jest.fn().mockResolvedValue([]),
        pickBestSale: jest.fn().mockReturnValue(null),
      },
      promotionsService: promotions,
      categoriesService: {
        findWithDescendantIds: jest.fn().mockResolvedValue([2, 3]),
      },
    });
    const module = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [{ provide: ProductsService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getActivePrepared.mockResolvedValue([]);
    qb.getManyAndCount.mockResolvedValue([[structuredClone(product)], 1]);
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves a non-empty product list through the real discount and promotion attachment code', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/api/products')
      .expect(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        id: 7,
        discount: null,
        promotionBadge: null,
        variants: [expect.objectContaining({ price: 100000 })],
      }),
    ]);
    expect(body.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 1,
      totalPages: 1,
    });
    expect(getActivePrepared).toHaveBeenCalledTimes(1);
    expect(qb.andWhere).toHaveBeenCalledWith('variant.stock > 0');
  });

  it('supports pagination, sorting and category/color/size filters', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/products?page=2&limit=6&sort=createdAt:desc&categoryIds=2&colorIds=4&sizeIds=5',
      )
      .expect(200);
    expect(qb.skip).toHaveBeenCalledWith(6);
    expect(qb.orderBy).toHaveBeenCalledWith('products.createdAt', 'DESC');
    expect(qb.andWhere).toHaveBeenCalledWith(
      'category.id IN (:...categoryIds)',
      { categoryIds: [2, 3] },
    );
    expect(qb.andWhere).toHaveBeenCalledWith('color.id IN (:...colorIds)', {
      colorIds: [4],
    });
    expect(qb.andWhere).toHaveBeenCalledWith('size.id IN (:...sizeIds)', {
      sizeIds: [5],
    });
  });

  it('returns an empty list without invoking promotion queries unnecessarily', async () => {
    qb.getManyAndCount.mockResolvedValue([[], 0]);
    const { body } = await request(app.getHttpServer())
      .get('/api/products')
      .expect(200);
    expect(body.data).toEqual([]);
    expect(getActivePrepared).not.toHaveBeenCalled();
  });

  it('keeps the actual product price when a promotion badge is present', async () => {
    getActivePrepared.mockResolvedValue([
      {
        promotion: {
          id: 12,
          isActive: true,
          startsAt: new Date('2020-01-01'),
          expiresAt: new Date('2100-01-01'),
          showBadgeOnProductCard: true,
          badgeText: 'پیشنهاد ویژه',
        },
        scope: { products: new Set([7]) },
      },
    ]);
    const { body } = await request(app.getHttpServer())
      .get('/api/products')
      .expect(200);
    expect(body.data[0].promotionBadge).toEqual({
      promotionId: 12,
      text: 'پیشنهاد ویژه',
    });
    expect(body.data[0].variants[0].price).toBe(100000);
  });
});
