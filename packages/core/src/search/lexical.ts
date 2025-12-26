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
    } catch (err) {
      disableBm25();
      console.warn("lexical.search.bm25_failed", {
        project_id: input.project_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return await lexicalFts(pool, input);
    }
  }

  return await lexicalFts(pool, input);
}
