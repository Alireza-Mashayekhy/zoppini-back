/**
 * uuid نسخه‌ی نصب‌شده ESM-only است و ProductGuidesService بهواسطه‌ی
 * FilesService آن را import میکند؛ در محیط CJS تست ماک میشود.
 */
jest.mock('uuid', () => ({ v4: () => 'test-id' }));

import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { UpsertSizeTableDto } from './dto/product-guides.dto';
import {
  SizeTable,
  SizeTableCell,
  SizeTableColumn,
  SizeTableRow,
} from './entities/size-table.entity';
import { ProductGuidesService } from './product-guides.service';

/**
 * شبیهساز TypeORM: چهار جدول سایزبندی بهصورت آرایه در حافظه، بههمراه
 * تراکنشی که در صورت خطا وضعیت قبل را برمیگرداند. هدف این است که دقیقاً
 * همان ترتیب عملیات `saveSizeTable` (ساخت/بهروزرسانی/حذف) اجرا شود.
 */
type AnyRecord = Record<string, any>;

class InMemoryStore {
  seq = 1000;
  tables: AnyRecord[] = [];
  columns: AnyRecord[] = [];
  rows: AnyRecord[] = [];
  cells: AnyRecord[] = [];
  failSaveFor: unknown[] = [];

  list(entity: unknown) {
    if (entity === SizeTable) return this.tables;
    if (entity === SizeTableColumn) return this.columns;
    if (entity === SizeTableRow) return this.rows;
    if (entity === SizeTableCell) return this.cells;

    throw new Error('unknown entity');
  }

  snapshot() {
    return JSON.parse(
      JSON.stringify({
        tables: this.tables,
        columns: this.columns,
        rows: this.rows,
        cells: this.cells,
      }),
    );
  }

  restore(snapshot: ReturnType<InMemoryStore['snapshot']>) {
    this.tables = snapshot.tables;
    this.columns = snapshot.columns;
    this.rows = snapshot.rows;
    this.cells = snapshot.cells;
  }
}

const matches = (item: AnyRecord, where: AnyRecord = {}) =>
  Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      const operator = expected as { type?: string; value?: unknown };

      if (operator.type === 'in' && Array.isArray(operator.value)) {
        return operator.value.includes(item[key]);
      }

      if ('value' in operator) return item[key] === operator.value;
    }

    return item[key] === expected;
  });

class FakeRepo {
  constructor(
    private readonly entity: unknown,
    private readonly store: InMemoryStore,
  ) {}

  create(data: AnyRecord) {
    return { ...data };
  }

  async save(input: AnyRecord) {
    await Promise.resolve();

    if (this.store.failSaveFor.includes(this.entity)) {
      throw new Error('simulated database failure');
    }

    const list = this.store.list(this.entity);

    if (input.id != null) {
      const index = list.findIndex(item => item.id === input.id);

      if (index >= 0) {
        list[index] = { ...list[index], ...input };

        return { ...list[index] };
      }
    }

    const saved = { ...input, id: ++this.store.seq };

    list.push(saved);

    return { ...saved };
  }

  async find(options: { where?: AnyRecord } = {}) {
    await Promise.resolve();

    return this.store
      .list(this.entity)
      .filter(item => matches(item, options.where))
      .map(item => ({ ...item }));
  }

  async delete(criteria: number | string | AnyRecord) {
    await Promise.resolve();

    const list = this.store.list(this.entity);

    if (typeof criteria === 'number' || typeof criteria === 'string') {
      const index = list.findIndex(item => item.id === Number(criteria));

      if (index >= 0) list.splice(index, 1);

      return;
    }

    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (matches(list[index], criteria)) list.splice(index, 1);
    }
  }

  async findOne(options: { where: AnyRecord; relations?: AnyRecord }) {
    await Promise.resolve();

    const found = this.store
      .list(this.entity)
      .find(item => matches(item, options.where));

    if (!found) return null;

    if (this.entity === SizeTable && options.relations) {
      return {
        ...found,
        columns: this.store.columns
          .filter(column => column.sizeTableId === found.id)
          .map(column => ({ ...column })),
        rows: this.store.rows
          .filter(row => row.sizeTableId === found.id)
          .map(row => ({
            ...row,
            cells: this.store.cells
              .filter(cell => cell.rowId === row.id)
              .map(cell => ({ ...cell })),
          })),
      };
    }

    return { ...found };
  }
}

const COLUMN_LABELS = ['S', 'M', 'L', 'XL', '2XL'];
const COLUMN_IDS = [11, 12, 13, 14, 15];
const ROW_IDS = [21, 22];

const seed = (store: InMemoryStore) => {
  store.tables.push({
    id: 1,
    name: 'سایزبندی پیراهن کلاسیک',
    unit: 'سانتیمتر',
    notes: null,
    isArchived: false,
  });

  COLUMN_IDS.forEach((id, index) =>
    store.columns.push({
      id,
      sizeTableId: 1,
      label: COLUMN_LABELS[index],
      order: index,
    }),
  );

  ROW_IDS.forEach((id, index) =>
    store.rows.push({
      id,
      sizeTableId: 1,
      label: index === 0 ? 'عرض سینه' : 'قد آستین',
      order: index,
    }),
  );

  for (const rowId of ROW_IDS) {
    COLUMN_IDS.forEach((columnId, index) =>
      store.cells.push({
        id: ++store.seq,
        rowId,
        columnId,
        value: rowId === 21 ? String(50 + index * 3) : String(60 + index),
      }),
    );
  }
};

const buildService = (store: InMemoryStore) => {
  const service = Object.create(ProductGuidesService.prototype);

  service.sizeTableRepo = new FakeRepo(SizeTable, store);
  service.dataSource = {
    transaction: async (callback: (manager: any) => Promise<unknown>) => {
      const snapshot = store.snapshot();

      try {
        return await callback({
          getRepository: (entity: unknown) => new FakeRepo(entity, store),
        });
      } catch (error) {
        store.restore(snapshot);
        throw error;
      }
    },
  };

  return {
    service: service as ProductGuidesService,
    save: (table: AnyRecord, dto: UpsertSizeTableDto) =>
      service.saveSizeTable(table, dto) as Promise<any>,
  };
};

const fullPayload = (overrides: Partial<UpsertSizeTableDto> = {}) => ({
  name: 'سایزبندی پیراهن کلاسیک',
  unit: 'سانتیمتر',
  notes: null,
  columns: COLUMN_IDS.map((id, index) => ({
    id,
    label: COLUMN_LABELS[index],
  })),
  rows: ROW_IDS.map((id, index) => ({
    id,
    label: index === 0 ? 'عرض سینه' : 'قد آستین',
    values: COLUMN_IDS.map((_, columnIndex) =>
      index === 0 ? String(50 + columnIndex * 3) : String(60 + columnIndex),
    ),
  })),
  ...overrides,
});

const tableOf = (store: InMemoryStore) => ({ ...store.tables[0] });

describe('ذخیره جدول سایزبندی — عدم پریدن سایزهای دیگر', () => {
  let store: InMemoryStore;
  let ctx: ReturnType<typeof buildService>;

  beforeEach(() => {
    store = new InMemoryStore();
    seed(store);
    ctx = buildService(store);
  });

  it('خروجی ادمین هم cells و هم values موقعیتی و همتراز دارد', async () => {
    const result = await (ctx.service.getSizeTable(1) as any);

    expect(result.data.columns.map((column: AnyRecord) => column.id)).toEqual(
      COLUMN_IDS,
    );
    expect(result.data.rows[0].values).toEqual(['50', '53', '56', '59', '62']);
    expect(result.data.rows[1].values).toEqual(['60', '61', '62', '63', '64']);
    expect(
      result.data.rows[0].cells.map((cell: AnyRecord) => cell.columnId),
    ).toEqual(COLUMN_IDS);
  });

  it('حذف دو سایز فقط همان دو ستون و سلولهایشان را حذف میکند', async () => {
    const admin = (await (ctx.service.getSizeTable(1) as any)).data;
    const kept = admin.columns.filter(
      (_: AnyRecord, index: number) => index !== 1 && index !== 3,
    );

    const payload = {
      ...fullPayload(),
      columns: kept.map((column: AnyRecord) => ({
        id: column.id,
        label: column.label,
      })),
      rows: admin.rows.map((row: AnyRecord) => ({
        id: row.id,
        label: row.label,
        values: admin.columns
          .map((column: AnyRecord, index: number) => ({
            id: column.id,
            value: row.values[index],
          }))
          .filter((cell: AnyRecord) =>
            kept.some((column: AnyRecord) => column.id === cell.id),
          )
          .map((cell: AnyRecord) => cell.value),
      })),
    };

    const saved = await ctx.save(tableOf(store), payload);

    expect(saved.columns.map((column: AnyRecord) => column.label)).toEqual([
      'S',
      'L',
      '2XL',
    ]);
    expect(
      store.columns
        .filter(column => column.sizeTableId === 1)
        .map(column => column.id),
    ).toEqual([11, 13, 15]);
    expect(saved.rows[0].cells.map((cell: AnyRecord) => cell.value)).toEqual([
      '50',
      '56',
      '62',
    ]);
    expect(saved.rows[1].cells.map((cell: AnyRecord) => cell.value)).toEqual([
      '60',
      '62',
      '64',
    ]);
    expect(store.cells.filter(cell => cell.columnId === 12)).toHaveLength(0);
    expect(store.cells.filter(cell => cell.columnId === 14)).toHaveLength(0);
    expect(store.rows).toHaveLength(2);
  });

  it('کلاینتی که values نفرستاده است مقادیر ذخیرهشده را پاک نمیکند', async () => {
    const payload = {
      ...fullPayload(),
      rows: [
        { id: 21, label: 'عرض سینه' },
        { id: 22, label: 'قد آستین' },
      ],
    };

    const saved = await ctx.save(tableOf(store), payload);

    expect(saved.rows[0].cells.map((cell: AnyRecord) => cell.value)).toEqual([
      '50',
      '53',
      '56',
      '59',
      '62',
    ]);
    expect(saved.rows[1].cells.map((cell: AnyRecord) => cell.value)).toEqual([
      '60',
      '61',
      '62',
      '63',
      '64',
    ]);
  });

  it('خانه خالی فقط همان سلول را پاک میکند، نه بقیه را', async () => {
    const payload = fullPayload();

    payload.rows[0].values[2] = '';

    const saved = await ctx.save(tableOf(store), payload);

    // تعریف خروجی بهازای هر ستون یک خانه دارد (خانه خالی = null)،
    // ولی ردیف اضافی null در دیتابیس باقی نمیماند.
    expect(saved.rows[0].cells.map((cell: AnyRecord) => cell.value)).toEqual([
      '50',
      '53',
      null,
      '59',
      '62',
    ]);
    expect(
      store.cells.filter(cell => cell.rowId === 21 && cell.columnId === 13),
    ).toHaveLength(0);
    expect(store.cells.filter(cell => cell.rowId === 21)).toHaveLength(4);
    expect(saved.rows[1].cells.map((cell: AnyRecord) => cell.value)).toEqual([
      '60',
      '61',
      '62',
      '63',
      '64',
    ]);
  });

  it('طول ناهماهنگ values، شناسه تکراری و شناسه بیگانه رد شده و چیزی تغییر نمیکند', async () => {
    const before = store.snapshot();

    await expect(
      ctx.save(
        tableOf(store),
        fullPayload({
          rows: [
            { id: 21, label: 'عرض سینه', values: ['1', '2'] },
            { id: 22, label: 'قد آستین', values: ['1', '2', '3', '4', '5'] },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      ctx.save(
        tableOf(store),
        fullPayload({
          columns: [
            { id: 11, label: 'S' },
            { id: 11, label: 'M' },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      ctx.save(
        tableOf(store),
        fullPayload({
          columns: [{ id: 999, label: 'S' }],
          rows: [
            {
              id: 21,
              label: 'عرض سینه',
              values: ['50'],
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(store.snapshot()).toEqual(before);
  });

  it('خطای میانهٔ ذخیره کل تراکنش را برمیگرداند', async () => {
    const before = store.snapshot();

    store.failSaveFor.push(SizeTableRow);

    await expect(
      ctx.save(tableOf(store), fullPayload({ name: 'اسم عوض شده' })),
    ).rejects.toThrow('simulated database failure');

    expect(store.snapshot()).toEqual(before);
  });

  it('ساخت کپی، ستون‌ها و ردیف‌ها و سلول‌ها را کامل و با هم منتقل میکند', async () => {
    const result = await (ctx.service.duplicateSizeTable as any)(1, 'کپی');
    const copyId = result.data.id;

    expect(copyId).not.toBe(1);
    expect(
      store.columns.filter(column => column.sizeTableId === copyId),
    ).toHaveLength(5);

    const copyRows = store.rows.filter(row => row.sizeTableId === copyId);

    expect(copyRows).toHaveLength(2);
    expect(
      store.cells.filter(cell => copyRows.some(row => row.id === cell.rowId)),
    ).toHaveLength(10);
    expect(
      store.cells
        .filter(cell => copyRows.some(row => row.id === cell.rowId))
        .map(cell => cell.value),
    ).toContain('50');
  });

  it('خطا در میانهٔ کپی، جدول ناقصی باقی نمی‌گذارد', async () => {
    const before = store.snapshot();

    store.failSaveFor.push(SizeTableRow);

    await expect((ctx.service.duplicateSizeTable as any)(1)).rejects.toThrow(
      'simulated database failure',
    );

    expect(store.snapshot()).toEqual(before);
  });

  it('ساخت جدول تازه سلول‌ها را با همان ترتیب ستون‌ها می‌سازد', async () => {
    const created = await (ctx.service.createSizeTable as any)({
      name: 'جدول تازه',
      unit: 'سانتیمتر',
      columns: [{ label: 'S' }, { label: 'M' }],
      rows: [{ label: 'عرض سینه', values: ['۵۰', '55.5'] }],
    });

    expect(created.data.rows[0].values).toEqual(['50', '55.5']);
    expect(created.data.rows[0].cells).toHaveLength(2);
    expect(created.data.columns).toHaveLength(2);
  });
});

describe('اعتبارسنجی UpsertSizeTableDto', () => {
  const validate = (plain: AnyRecord) =>
    validateSync(plainToInstance(UpsertSizeTableDto, plain));

  it('بدون values معتبر است ولی ستون/ردیف خالی نه', () => {
    expect(
      validate({
        name: 'جدول',
        columns: [{ label: 'S' }],
        rows: [{ label: 'عرض سینه' }],
      }),
    ).toHaveLength(0);
    expect(
      validate({ name: 'جدول', columns: [], rows: [] }).length,
    ).toBeGreaterThan(0);
    expect(
      validate({
        name: 'جدول',
        columns: [{ label: '' }],
        rows: [{ label: 'عرض سینه' }],
      }).length,
    ).toBeGreaterThan(0);
  });
});
