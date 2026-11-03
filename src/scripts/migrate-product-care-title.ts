import dataSource from 'src/common/config/typeorm-care-title-datasource';

async function main() {
  await dataSource.initialize();
  try {
    const queryRunner = dataSource.createQueryRunner();
    let hasProduct: boolean;
    try {
      hasProduct = await queryRunner.hasTable('product');
    } finally {
      await queryRunner.release();
    }
    // Do not mark the migration as executed on the wrong or empty database.
    if (!hasProduct) {
      throw new Error(
        'The product table does not exist; check DATABASE_* settings.',
      );
    }
    const executed = await dataSource.runMigrations();
    console.log(
      executed.length
        ? 'Product care title migration completed.'
        : 'Product care title migration was already applied.',
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('Product care title migration failed:', error);
  process.exitCode = 1;
});
