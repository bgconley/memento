import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, withTransaction } from "../../src/db";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for db tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

async function ensureTestTable() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS __memento_tx_test (id SERIAL PRIMARY KEY, value TEXT NOT NULL)"
  );
}

describe("withTransaction", () => {
  beforeAll(async () => {
    await ensureTestTable();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE __memento_tx_test");
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS __memento_tx_test");
    await pool.end();
  });

  it("commits on success", async () => {
    await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO __memento_tx_test (value) VALUES ($1)", ["ok"]);
    });

    const result = await pool.query("SELECT value FROM __memento_tx_test");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].value).toBe("ok");
  });

  it("rolls back on error", async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("INSERT INTO __memento_tx_test (value) VALUES ($1)", ["nope"]);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const result = await pool.query("SELECT value FROM __memento_tx_test");
    expect(result.rows).toHaveLength(0);
  });
});
