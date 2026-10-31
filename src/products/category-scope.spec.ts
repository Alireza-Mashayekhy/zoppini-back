jest.mock('uuid', () => ({ v4: () => 'test-id' }));

import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

describe('public product category scope', () => {
  function setup() {
    const qb: any = {};
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
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
    const categoriesService = {
      findWithDescendantIds: jest.fn().mockResolvedValue([12, 13]),
    };
    const service = Object.create(ProductsService.prototype) as ProductsService;
    Object.assign(service, {
      productRepo: { createQueryBuilder: () => qb },
      categoriesService,
      attachDiscounts: jest.fn().mockResolvedValue(undefined),
    });
    return { service, categoriesService, qb };
  }

  it('keeps descendants in the existing category listing', async () => {
    const { service, categoriesService, qb } = setup();
    await service.findAll(
      { page: 1, limit: 6 },
      { categoryIds: [12] },
      { onlyInStock: true },
    );
    expect(categoriesService.findWithDescendantIds).toHaveBeenCalledWith([12]);
    expect(qb.andWhere).toHaveBeenCalledWith(
      'category.id IN (:...categoryIds)',
      { categoryIds: [12, 13] },
    );
    expect(qb.andWhere).toHaveBeenCalledWith('variant.stock > 0');
  });

  it('uses only the assigned category for the direct section', async () => {
    const { service, categoriesService, qb } = setup();
    await service.findAll(
      { page: 1, limit: 6 },
      { categoryIds: [12], directCategory: true },
      { onlyInStock: true },
    );
    expect(categoriesService.findWithDescendantIds).not.toHaveBeenCalled();
    expect(qb.andWhere).toHaveBeenCalledWith(
      'category.id IN (:...categoryIds)',
      { categoryIds: [12] },
    );
  });

  it('opts in only for the explicit true query value', () => {
    const findAll = jest.fn();
    const controller = new ProductsController({
      findAll,
    } as unknown as ProductsService);
    controller.findAll({}, '12', undefined, undefined, 'true');
    expect(findAll.mock.calls[0][1]).toMatchObject({
      categoryIds: [12],
      directCategory: true,
    });
    controller.findAll({}, '12', undefined, undefined, 'false');
    expect(findAll.mock.calls[1][1]).toMatchObject({ directCategory: false });
  });
});
