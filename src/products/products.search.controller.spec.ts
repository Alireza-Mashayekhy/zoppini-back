import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

jest.mock('./products.service', () => ({
  ProductsService: class ProductsService {},
}));

import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

describe('ProductsController search suggestions route', () => {
  let app: INestApplication;
  const getSearchSuggestions = jest.fn();

  beforeAll(async () => {
    getSearchSuggestions.mockResolvedValue({
      data: { term: 'پیراهن', related: [], popular: [], categories: [] },
    });

    const module = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [
        {
          provide: ProductsService,
          useValue: { getSearchSuggestions },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('routes the static search endpoint before the dynamic product slug route', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/products/search-suggestions?search=%D9%BE%DB%8C%D8%B1%D8%A7%D9%87%D9%86',
      )
      .expect(200);

    expect(getSearchSuggestions).toHaveBeenCalledWith('پیراهن', undefined);
  });
});
