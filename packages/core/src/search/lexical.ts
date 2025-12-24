import type { Pool } from "pg";
import type { SearchFilters, LexicalMatch } from "./filters";
import { lexicalBm25 } from "./bm25/lexicalBm25";
import { lexicalFts } from "./bm25/lexicalFts";
import { disableBm25, getBm25Capabilities } from "./bm25/capabilities";
import type { LexicalSearchOptions } from "./lexicalTypes";
export type { LexicalSearchOptions } from "./lexicalTypes";

export async function lexicalSearch(
  pool: Pool,
  input: {
    project_id: string;
    query: string;
    filters?: SearchFilters;
    options?: LexicalSearchOptions;
  }
): Promise<LexicalMatch[]> {
  const capabilities = await getBm25Capabilities(pool);
  if (capabilities) {
    try {
      return await lexicalBm25(pool, { ...input, capabilities });
    } catch {
      disableBm25();
      return await lexicalFts(pool, input);
    }
  }

  return await lexicalFts(pool, input);
}
