import { Pool } from "pg";

let singletonPool: Pool | null = null;

export type PoolOptions = {
  connectionString: string;
  max?: number;
  applicationName?: string;
};

export function createPool(options: PoolOptions): Pool {
  return new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? "memento-core",
  });
}

export function getPool(): Pool {
  if (singletonPool) return singletonPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  singletonPool = createPool({ connectionString });
  return singletonPool;
}

export async function closePool(): Promise<void> {
  if (!singletonPool) return;
  await singletonPool.end();
  singletonPool = null;
}
