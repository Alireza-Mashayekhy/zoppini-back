import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * جدول تصاویر صفحه اصلی (`site_images`).
 *
 * هر رکورد یک جایگاه از صفحه اصلی است (بنر فروش ویژه، تصاویر دسته‌بندی،
 * پوستر ویدیوها) به‌همراه تصویر دسکتاپ، تصویر موبایل (اختیاری)، متن
 * جایگزین و لینک.
 *
 * در محیط توسعه `synchronize` هم این جدول را می‌سازد؛ این مایگریشن
 * برای محیط تولید (که synchronize خاموش است) و به‌صورت idempotent نوشته
 * شده است.
 */
export class SiteImages1798000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (await q.hasTable('site_images')) return;

    await q.createTable(
      new Table({
        name: 'site_images',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'slot', type: 'varchar', length: '100', isNullable: false },
          {
            name: 'desktop_image',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'mobile_image',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          { name: 'alt', type: 'varchar', length: '255', isNullable: true },
          {
            name: 'link_url',
            type: 'varchar',
            length: '2048',
            isNullable: true,
          },
          { name: 'is_active', type: 'boolean', default: true },
          {
            name: 'created_at',
            type: 'datetime',
            precision: 6,
            default: 'CURRENT_TIMESTAMP(6)',
          },
          {
            name: 'updated_at',
            type: 'datetime',
            precision: 6,
            default: 'CURRENT_TIMESTAMP(6)',
            onUpdate: 'CURRENT_TIMESTAMP(6)',
          },
        ],
        indices: [
          new TableIndex({
            name: 'IDX_site_images_slot',
            columnNames: ['slot'],
            isUnique: true,
          }),
        ],
      }),
    );
  }

  async down(q: QueryRunner): Promise<void> {
    if (await q.hasTable('site_images')) {
      await q.dropTable('site_images');
    }
  }
}
