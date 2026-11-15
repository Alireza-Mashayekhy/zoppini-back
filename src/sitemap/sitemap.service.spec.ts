import { SitemapService } from './sitemap.service';

/**
 * تست‌های واحدِ سیاستِ نقشه‌ی سایتِ محصولات.
 *
 * هدف: تثبیتِ این رفتار که «موجودی» (stock) معیارِ حذف از نقشه‌ی سایت نیست،
 * در حالی که `indexable` و مسیرهای noindex/ریدایرکتِ پنل سئو همچنان حذف
 * می‌شوند. این تست‌ها به پایگاه داده وصل نمی‌شوند؛ مخزن‌ها با یک QueryBuilder
 * ساختگی جایگزین شده‌اند.
 */

/** QueryBuilder ساختگی که فقط فراخوانی‌ها را ضبط می‌کند. */
class FakeProductQueryBuilder {
  readonly selects: string[] = [];
  readonly wheres: string[] = [];

  constructor(private readonly rows: unknown[]) {}

  select(expression: string) {
    this.selects.push(expression);
    return this;
  }

  addSelect(expression: string) {
    this.selects.push(expression);
    return this;
  }

  where(expression: string) {
    this.wheres.push(expression);
    return this;
  }

  andWhere(expression: string) {
    this.wheres.push(expression);
    return this;
  }

  getRawMany<T>(): Promise<T[]> {
    return Promise.resolve(this.rows as T[]);
  }
}

interface ProductRow {
  title: string;
  slug: string;
  updatedAt?: Date | string | null;
}

async function createService(options: {
  productRows: ProductRow[];
  excludedPaths?: string[];
}) {
  const qb = new FakeProductQueryBuilder(options.productRows);

  const productRepo = { createQueryBuilder: jest.fn(() => qb) };
  const categoryRepo = { find: () => Promise.resolve([]) };
  const blogRepo = { find: () => Promise.resolve([]) };
  const seoService = {
    getExcludedPaths: () => Promise.resolve(options.excludedPaths ?? []),
  };

  const service = new SitemapService(
    categoryRepo as never,
    productRepo as never,
    blogRepo as never,
    seoService as never,
  );

  const data = await service.getSitemapData();

  return { service, data, qb, productRepo, seoService };
}

describe('SitemapService — product sitemap policy', () => {
  it('includes products that have stock', async () => {
    const { data } = await createService({
      productRows: [
        { title: 'شلوار کلاسیک', slug: 'classic-trousers', updatedAt: null },
      ],
    });

    expect(data.products).toEqual([
      { name: 'شلوار کلاسیک', slug: 'classic-trousers', updatedAt: null },
    ]);
  });

  it('includes temporarily out-of-stock products (stock is not a sitemap filter)', async () => {
    const { data, qb } = await createService({
      productRows: [
        {
          title: 'ناموجود',
          slug: 'out-of-stock-product',
          updatedAt: null,
        },
      ],
    });

    expect(data.products.map(item => item.slug)).toEqual([
      'out-of-stock-product',
    ]);

    // هیچ شرطی روی موجودی نباید وجود داشته باشد
    const joinedWheres = qb.wheres.join(' ');
    expect(joinedWheres).not.toMatch(/stock/i);
    expect(joinedWheres).not.toMatch(/variant/i);
  });

  it('still excludes non-indexable products at the query level', async () => {
    const { qb } = await createService({ productRows: [] });

    expect(qb.wheres).toContain('product.indexable = 1');
  });

  it('deleted products simply never appear (no rows, no fabricated entries)', async () => {
    const { data } = await createService({ productRows: [] });

    expect(data.products).toEqual([]);
  });

  it('excludes paths that the SEO panel marked noindex or redirected', async () => {
    const { data } = await createService({
      productRows: [
        { title: 'مخفی', slug: 'hidden-product', updatedAt: null },
        { title: 'عادی', slug: 'visible-product', updatedAt: null },
      ],
      excludedPaths: ['/product/hidden-product'],
    });

    expect(data.products.map(item => item.slug)).toEqual(['visible-product']);
  });

  it('selects the real updatedAt column for lastmod', async () => {
    const { qb } = await createService({ productRows: [] });

    expect(qb.selects).toContain('product.updatedAt');
    expect(qb.selects).toContain('product.slug');
  });

  it('never fabricates a lastmod: null stays null and invalid dates become null', async () => {
    const { data } = await createService({
      productRows: [
        { title: 'بدون زمان', slug: 'no-date', updatedAt: null },
        { title: 'زمان نامعتبر', slug: 'bad-date', updatedAt: 'not-a-date' },
      ],
    });

    expect(data.products).toEqual([
      { name: 'بدون زمان', slug: 'no-date', updatedAt: null },
      { name: 'زمان نامعتبر', slug: 'bad-date', updatedAt: null },
    ]);
  });

  it('normalises Date and string values to ISO (no inventory-sync timestamps invented)', async () => {
    const iso = '2026-08-08T10:09:33.000Z';

    const { data } = await createService({
      productRows: [
        { title: 'با Date', slug: 'date-value', updatedAt: new Date(iso) },
        { title: 'با رشته', slug: 'string-value', updatedAt: iso },
      ],
    });

    expect(data.products[0].updatedAt).toBe(iso);
    expect(data.products[1].updatedAt).toBe(iso);
  });
});
