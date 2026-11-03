import { ProductCareInstructionsTitle1799000000000 } from 'src/migrations/1799000000000-ProductCareInstructionsTitle';
import { DataSource } from 'typeorm';

import defaultDataSource from './typeorm-datasource';

/** Same database and migrations table as the normal CLI, but only this migration. */
export default new DataSource({
  ...defaultDataSource.options,
  migrations: [ProductCareInstructionsTitle1799000000000],
  migrationsRun: false,
  synchronize: false,
});
