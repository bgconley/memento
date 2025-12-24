import type { PoolClient } from "pg";

export type DbClient = {
  query: PoolClient["query"];
};
