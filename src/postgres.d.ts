import type { Store } from './index.js';

export interface PostgresClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(error?: Error | boolean): void;
}

export interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

/** The schema must already exist. initialize() explicitly creates only the table. */
export function createPostgresStore(
  pool: PostgresPool,
  options?: { schema?: string },
): Store & { initialize(): Promise<void> };
