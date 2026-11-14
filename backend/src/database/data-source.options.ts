import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

/** Options shared by the application and the migration CLI. */
export function dataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    // The schema changes only through migrations.
    synchronize: false,
    migrations: [join(import.meta.dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'schema_migrations',
  };
}
