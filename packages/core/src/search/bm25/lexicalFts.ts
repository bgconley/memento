import type { Pool } from "pg";
import { appendItemFilters, type LexicalMatch, type SearchFilters } from "../filters";
import type { LexicalSearchOptions } from "../lexicalTypes";

const DEFAULT_TOP_K = 40;
const DEFAULT_MAX_CHUNK_CHARS = 300;
const DEFAULT_TRIGRAM_WEIGHT = 0.3;

function shouldUseTrigram(query: string): boolean {
  if (query.trim().length < 3) return false;
  return /[A-Z0-9_:\/\.-]/.test(query);
}

export async function lexicalFts(
  pool: Pool,
  input: {
    project_id: string;
    query: string;
    filters?: SearchFilters;
    options?: LexicalSearchOptions;
  }
): Promise<LexicalMatch[]> {
  const { project_id, query, filters, options } = input;
  const topK = options?.top_k ?? DEFAULT_TOP_K;
  const maxChars = options?.max_chunk_chars ?? DEFAULT_MAX_CHUNK_CHARS;
  const trigramWeight = options?.trigram_weight ?? DEFAULT_TRIGRAM_WEIGHT;

  const useTrigram = shouldUseTrigram(query);
  const values: unknown[] = [query, project_id];

  const where = [
    "mc.project_id = $2",
    "mi.project_id = $2",
    "mi.status = 'active'",
  ];

  where.push(...appendItemFilters(filters, values, "mi"));

  const tsQuery = "websearch_to_tsquery('english', $1)";
  const tsvector = "coalesce(mc.tsv, ''::tsvector)";
  const matchClause = useTrigram
    ? `(${tsvector} @@ ${tsQuery} OR mc.chunk_text % $1)`
    : `${tsvector} @@ ${tsQuery}`;

  where.push(matchClause);

  values.push(maxChars);
  const maxParam = `$${values.length}`;
  values.push(topK);
  const limitParam = `$${values.length}`;

  const trigramScoreExpr = useTrigram ? `similarity(mc.chunk_text, $1)` : "0";
  const lexicalScoreExpr = `ts_rank_cd(${tsvector}, ${tsQuery})`;
  const scoreExpr = `(${lexicalScoreExpr}) + (${trigramWeight} * ${trigramScoreExpr})`;

  const sql = `
    SELECT
      mc.id AS chunk_id,
      mv.id AS version_id,
      mv.version_num,
      mi.id AS item_id,
      mi.title,
      mi.kind,
      mi.scope,
      mi.canonical_key,
      mi.pinned,
      mi.tags,
      mc.heading_path,
      mc.section_anchor,
      LEFT(mc.chunk_text, ${maxParam}) AS excerpt,
      ${lexicalScoreExpr} AS lexical_score,
      ${trigramScoreExpr} AS trigram_score,
      ${scoreExpr} AS score
    FROM memory_chunks mc
    JOIN memory_versions mv ON mv.id = mc.version_id
    JOIN memory_items mi ON mi.id = mv.item_id
    WHERE ${where.join(" AND ")}
    ORDER BY score DESC
    LIMIT ${limitParam}
  `;

  const result = await pool.query(sql, values);
  return result.rows.map((row) => ({
    chunk_id: row.chunk_id,
    version_id: row.version_id,
    version_num: Number(row.version_num),
    item_id: row.item_id,
    title: row.title,
    kind: row.kind,
    scope: row.scope,
    canonical_key: row.canonical_key,
    pinned: row.pinned,
    tags: row.tags ?? [],
    heading_path: row.heading_path ?? [],
    section_anchor: row.section_anchor,
    excerpt: row.excerpt ?? "",
    lexical_score: Number(row.lexical_score ?? 0),
    trigram_score: Number(row.trigram_score ?? 0),
    score: Number(row.score ?? 0),
  }));
}
