export type SearchFilters = {
  kinds?: string[];
  scopes?: string[];
  pinned_only?: boolean;
  canonical_only?: boolean;
  doc_classes?: string[];
  tags_all?: string[];
  tags_any?: string[];
  created_after?: string;
  item_ids?: string[];
};

export type SearchMatch = {
  chunk_id: string;
  version_id: string;
  version_num: number;
  item_id: string;
  title: string;
  kind: string;
  scope: string;
  canonical_key: string | null;
  pinned: boolean;
  tags: string[];
  heading_path: string[];
  section_anchor: string | null;
  excerpt: string;
  score: number;
};

export type LexicalMatch = SearchMatch & {
  lexical_score: number;
  trigram_score: number;
};

export type SemanticMatch = SearchMatch & {
  distance: number;
};

export function appendItemFilters(
  filters: SearchFilters | undefined,
  values: unknown[],
  alias = "mi"
): string[] {
  const where: string[] = [];

  if (filters?.kinds?.length) {
    values.push(filters.kinds);
    where.push(`${alias}.kind = ANY($${values.length})`);
  }
  if (filters?.scopes?.length) {
    values.push(filters.scopes);
    where.push(`${alias}.scope = ANY($${values.length})`);
  }
  if (filters?.pinned_only) {
    where.push(`${alias}.pinned = true`);
  }
  if (filters?.canonical_only) {
    where.push(`${alias}.canonical_key IS NOT NULL`);
  }
  if (filters?.doc_classes?.length) {
    values.push(filters.doc_classes);
    where.push(`${alias}.doc_class = ANY($${values.length})`);
  }
  if (filters?.tags_all?.length) {
    values.push(filters.tags_all);
    where.push(`${alias}.tags @> $${values.length}::text[]`);
  }
  if (filters?.tags_any?.length) {
    values.push(filters.tags_any);
    where.push(`${alias}.tags && $${values.length}::text[]`);
  }
  if (filters?.created_after) {
    values.push(filters.created_after);
    where.push(`${alias}.created_at >= $${values.length}::timestamptz`);
  }
  if (filters?.item_ids?.length) {
    values.push(filters.item_ids);
    where.push(`${alias}.id = ANY($${values.length})`);
  }

  return where;
}
