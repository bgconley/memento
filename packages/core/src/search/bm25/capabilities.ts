import type { Pool } from "pg";

export type Bm25Capabilities = {
  operator: "@@@" | "|||";
  scoreFunction: "paradedb.score" | "pdb.score";
  pgSearchVersion: string | null;
};

let cached: Bm25Capabilities | null | undefined = undefined;

export async function isPgSearchInstalled(pool: Pool): Promise<boolean> {
  const extension = await pool.query(
    "SELECT extversion FROM pg_extension WHERE extname = 'pg_search'"
  );
  return (extension.rowCount ?? 0) > 0;
}

export async function getPgSearchVersion(pool: Pool): Promise<string | null> {
  const extension = await pool.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'pg_search'"
  );
  if (extension.rowCount === 0) return null;
  return extension.rows[0].extversion ?? null;
}

export async function hasBm25IndexOnMemoryChunks(pool: Pool): Promise<boolean> {
  const index = await pool.query(
    "SELECT 1 FROM pg_indexes WHERE tablename = 'memory_chunks' AND indexdef ILIKE '%USING bm25%'"
  );
  return (index.rowCount ?? 0) > 0;
}

export async function getBm25Capabilities(pool: Pool): Promise<Bm25Capabilities | null> {
  if (cached !== undefined) return cached;

  const installed = await isPgSearchInstalled(pool);
  if (!installed) {
    cached = null;
    return cached;
  }

  const hasIndex = await hasBm25IndexOnMemoryChunks(pool);
  if (!hasIndex) {
    cached = null;
    return cached;
  }

  const operatorResult = await pool.query<{ oprname: string }>(
    "SELECT oprname FROM pg_operator WHERE oprname IN ('@@@', '|||') ORDER BY CASE WHEN oprname = '@@@' THEN 0 ELSE 1 END LIMIT 1"
  );
  const operator = operatorResult.rows[0]?.oprname as "@@@" | "|||" | undefined;

  const scoreResult = await pool.query<{ nspname: string }>(
    "SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'score' AND n.nspname IN ('paradedb', 'pdb') ORDER BY CASE WHEN n.nspname = 'paradedb' THEN 0 ELSE 1 END LIMIT 1"
  );
  const schemaName = scoreResult.rows[0]?.nspname;
  const scoreFunction = schemaName
    ? (`${schemaName}.score` as "paradedb.score" | "pdb.score")
    : undefined;

  if (!operator || !scoreFunction) {
    cached = null;
    return cached;
  }

  cached = {
    operator,
    scoreFunction,
    pgSearchVersion: await getPgSearchVersion(pool),
  };
  return cached;
}

export function disableBm25(): void {
  cached = null;
}
