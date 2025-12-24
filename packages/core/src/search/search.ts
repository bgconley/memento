import type { Pool } from "pg";
import { fuseRankings, type FusionOptions, type FusionMatch } from "./fusion";
import { lexicalSearch } from "./lexical";
import { semanticSearch } from "./semantic";
import type { SearchFilters } from "./filters";

export type HybridSearchOptions = {
  lexical_top_k: number;
  semantic_top_k: number;
  include_chunks: boolean;
  max_chunk_chars: number;
  fusion?: FusionOptions;
};

export type HybridSearchResult = {
  query: string;
  results: Array<{
    item: {
      item_id: string;
      title: string;
      kind: string;
      scope: string;
      canonical_key: string | null;
      pinned: boolean;
      tags: string[];
    };
    best_chunks?: Array<{
      chunk_id: string;
      version_id: string;
      version_num: number;
      score: number;
      excerpt: string;
      heading_path: string[];
      section_anchor: string | null;
    }>;
    resource_uri: string;
  }>;
  debug?: Record<string, unknown>;
};

const DEFAULT_MAX_CHUNKS = 3;

const WEIGHT_PROFILES = {
  default: { lexical: 0.4, semantic: 0.5, trigram: 0.1 },
  code: { lexical: 0.3, semantic: 0.3, trigram: 0.4 },
  technical: { lexical: 0.5, semantic: 0.35, trigram: 0.15 },
  conversational: { lexical: 0.25, semantic: 0.7, trigram: 0.05 },
} as const;

type WeightProfileKey = keyof typeof WEIGHT_PROFILES;

function buildItemUri(projectId: string, itemId: string): string {
  return `memory://projects/${projectId}/items/${itemId}`;
}

function inferQueryStyle(query: string): WeightProfileKey {
  const normalized = query.trim();
  if (!normalized) return "default";
  const hasStackTrace = /\bat\s+\S+\s+\(/.test(normalized) || /\bException\b|\bError\b:/.test(normalized);
  const hasCodeTokens = /[{}();<>]|=>|::|->|\b[A-Z][a-z]+[A-Z]/.test(normalized);
  const hasIdentifiers = /[_$][A-Za-z]|[A-Za-z]\w+\.\w+/.test(normalized);
  if (hasStackTrace || hasCodeTokens || hasIdentifiers) return "code";

  const wordCount = normalized.split(/\s+/).length;
  if (wordCount >= 6) return "conversational";
  return "technical";
}

function resolveFusionOptions(query: string, overrides?: FusionOptions): FusionOptions | undefined {
  if (!overrides) {
    const style = inferQueryStyle(query);
    return { weights: WEIGHT_PROFILES[style] };
  }
  if (overrides.weights) {
    return overrides;
  }
  const style = inferQueryStyle(query);
  return { ...overrides, weights: WEIGHT_PROFILES[style] };
}

function groupByItem(
  matches: FusionMatch[],
  maxChunks: number
): Array<{ item: HybridSearchResult["results"][number]["item"]; chunks: FusionMatch[] }> {
  const grouped = new Map<string, { item: HybridSearchResult["results"][number]["item"]; chunks: FusionMatch[] }>();

  for (const match of matches) {
    const existing = grouped.get(match.item_id);
    if (!existing) {
      grouped.set(match.item_id, {
        item: {
          item_id: match.item_id,
          title: match.title,
          kind: match.kind,
          scope: match.scope,
          canonical_key: match.canonical_key,
          pinned: match.pinned,
          tags: match.tags,
        },
        chunks: [match],
      });
    } else if (existing.chunks.length < maxChunks) {
      existing.chunks.push(match);
    }
  }

  const results: Array<{ item: HybridSearchResult["results"][number]["item"]; chunks: FusionMatch[] }> = [];
  for (const entry of grouped.values()) {
    entry.chunks.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.chunk_id.localeCompare(b.chunk_id);
    });

    results.push({ item: entry.item, chunks: entry.chunks.slice(0, maxChunks) });
  }

  results.sort((a, b) => {
    const aScore = a.chunks[0]?.score ?? 0;
    const bScore = b.chunks[0]?.score ?? 0;
    if (bScore !== aScore) return bScore - aScore;
    return a.item.item_id.localeCompare(b.item.item_id);
  });

  return results;
}

export async function hybridSearch(
  pool: Pool,
  input: {
    project_id: string;
    query: string;
    filters?: SearchFilters;
    options: HybridSearchOptions;
  }
): Promise<HybridSearchResult> {
  const { project_id, query, filters, options } = input;

  const lexicalMatches = await lexicalSearch(pool, {
    project_id,
    query,
    filters,
    options: { top_k: options.lexical_top_k, max_chunk_chars: options.max_chunk_chars },
  });

  const semantic = await semanticSearch(pool, {
    project_id,
    query,
    filters,
    options: { top_k: options.semantic_top_k, max_chunk_chars: options.max_chunk_chars },
  });

  const fusionOptions = resolveFusionOptions(query, options.fusion);
  const fused = fuseRankings(lexicalMatches, semantic.matches, fusionOptions);

  const grouped = groupByItem(fused, DEFAULT_MAX_CHUNKS);
  const results = grouped.map((entry) => ({
    item: entry.item,
    best_chunks: options.include_chunks
      ? entry.chunks.map((chunk) => ({
          chunk_id: chunk.chunk_id,
          version_id: chunk.version_id,
          version_num: chunk.version_num,
          score: chunk.score,
          excerpt: chunk.excerpt,
          heading_path: chunk.heading_path,
          section_anchor: chunk.section_anchor,
        }))
      : undefined,
    resource_uri: buildItemUri(project_id, entry.item.item_id),
  }));

  return {
    query,
    results,
    debug: {
      lexical_count: lexicalMatches.length,
      semantic_count: semantic.matches.length,
      semantic_reason: semantic.reason,
      profile_id: semantic.profile_id,
    },
  };
}
