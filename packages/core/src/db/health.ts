import type { Pool } from "pg";

export type DbHealth = {
  ok: boolean;
  vectorExtension: boolean;
  checkedAt: string;
  error?: string;
};

export async function checkDbHealth(pool: Pool): Promise<DbHealth> {
  const checkedAt = new Date().toISOString();

  try {
    await pool.query("SELECT 1");
    const result = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'"
    );
    const vectorExtension = (result.rowCount ?? 0) > 0;

    return {
      ok: vectorExtension,
      vectorExtension,
      checkedAt,
      error: vectorExtension ? undefined : "pgvector extension not installed",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, vectorExtension: false, checkedAt, error: message };
  }
}
