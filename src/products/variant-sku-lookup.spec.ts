jest.mock('uuid', () => ({ v4: () => 'test-id' }));

import { ProductsService } from './products.service';

/**
 * پیدا کردن محصولی که یک SKU مشخص را در واریانت‌هایش دارد.
 *
 * این متد پایه‌ی «افزودن کالای راهکاران به محصول» است: چون SKU یکتاست،
 * با آن مشخص می‌کنیم کالای راهکاران قبلاً به کدام محصول وصل شده است.
 */
describe('findByVariantSku', () => {
  function setup(variant: any = null, product: any = null) {
    const qb: any = {
      where: jest.fn(),
      getOne: jest.fn().mockResolvedValue(variant),
    };
    qb.where.mockReturnValue(qb);

    const variantRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    const productRepo = {
      findOne: jest.fn().mockResolvedValue(product),
    };

    const service = Object.create(ProductsService.prototype) as ProductsService;
    Object.assign(service, { variantRepo, productRepo });

    return { service, variantRepo, productRepo, qb };
  }

  it('returns null without querying the database when the sku is empty', async () => {
    const { service, variantRepo } = setup();

    await expect(service.findByVariantSku('   ')).resolves.toBeNull();
    expect(variantRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('normalizes Persian digits before comparing the sku', async () => {
    const { service, qb } = setup({ productId: 7 });

    await service.findByVariantSku('۱۲۳۴');

    expect(qb.where).toHaveBeenCalledWith('TRIM(variant.sku) = :sku', {
      sku: '1234',
    });
  });

  it('returns the product that owns the variant sku', async () => {
    const product = { id: 7, title: 'کت شلوار' };
    const { service, productRepo } = setup({ productId: 7 }, product);

    await expect(service.findByVariantSku('1234')).resolves.toBe(product);
    expect(productRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } }),
    );
  });

  it('returns null when no variant carries the sku', async () => {
    const { service, productRepo } = setup(null);

    await expect(service.findByVariantSku('9999')).resolves.toBeNull();
    expect(productRepo.findOne).not.toHaveBeenCalled();
  });
});
