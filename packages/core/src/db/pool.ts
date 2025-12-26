import { Pool } from "pg";

let singletonPool: Pool | null = null;

export type PoolOptions = {
  connectionString: string;
  max?: number;
  applicationName?: string;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  maxUses?: number;
  allowExitOnIdle?: boolean;
  onError?: (err: unknown) => void;
};

function readNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  if (value === "1") return true;
  if (value === "0") return false;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

export function createPool(options: PoolOptions): Pool {
  const max = options.max ?? readNumber(process.env.DB_POOL_MAX) ?? 10;
  const idleTimeoutMillis =
    options.idleTimeoutMillis ?? readNumber(process.env.DB_POOL_IDLE_TIMEOUT_MS);
  const connectionTimeoutMillis =
    options.connectionTimeoutMillis ?? readNumber(process.env.DB_POOL_CONN_TIMEOUT_MS);
  const maxUses = options.maxUses ?? readNumber(process.env.DB_POOL_MAX_USES);
  const allowExitOnIdle =
    options.allowExitOnIdle ?? readBoolean(process.env.DB_POOL_ALLOW_EXIT_ON_IDLE);

  const pool = new Pool({
    connectionString: options.connectionString,
    max,
    application_name: options.applicationName ?? "memento-core",
    idleTimeoutMillis,
    connectionTimeoutMillis,
    maxUses,
    allowExitOnIdle,
  });

  const onError = options.onError ?? ((err) => console.error("db.pool.error", err));
  pool.on("error", onError);

  return pool;
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
