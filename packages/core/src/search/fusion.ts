import type { LexicalMatch, SemanticMatch } from "./filters";

export type FusionWeights = {
  lexical: number;
  semantic: number;
  trigram: number;
};

export type FusionOptions = {
  k?: number;
  weights?: FusionWeights;
  canonical_boost?: number;
  pinned_boost?: number;
};

export type FusionMatch = {
  chunk_id: string;
  item_id: string;
  version_id: string;
  version_num: number;
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

const DEFAULT_WEIGHTS: FusionWeights = {
  lexical: 0.4,
  semantic: 0.5,
  trigram: 0.1,
};

const DEFAULT_K = 60;
const DEFAULT_CANONICAL_BOOST = 0.1;
const DEFAULT_PINNED_BOOST = 0.1;

type RankedList = {
  weight: number;
  entries: Array<{ chunk_id: string; rank: number }>;
};

function buildRankedList<T>(
  matches: T[],
  weight: number,
  compare: (a: T, b: T) => number,
  getChunkId: (value: T) => string,
  filter?: (value: T) => boolean
): RankedList {
  const filtered = filter ? matches.filter(filter) : matches.slice();
  filtered.sort(compare);
  const entries = filtered.map((value, index) => ({
    chunk_id: getChunkId(value),
    rank: index + 1,
  }));
  return { weight, entries };
}

function defaultTieBreak(a: FusionMatch, b: FusionMatch): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.item_id !== b.item_id) return a.item_id.localeCompare(b.item_id);
  return a.chunk_id.localeCompare(b.chunk_id);
}

export function fuseRankings(
  lexicalMatches: LexicalMatch[],
  semanticMatches: SemanticMatch[],
  options?: FusionOptions
): FusionMatch[] {
  const k = options?.k ?? DEFAULT_K;
  const weights = { ...DEFAULT_WEIGHTS, ...(options?.weights ?? {}) };
  const canonicalBoost = options?.canonical_boost ?? DEFAULT_CANONICAL_BOOST;
  const pinnedBoost = options?.pinned_boost ?? DEFAULT_PINNED_BOOST;

  const rankedLists: RankedList[] = [];
  const combined = [...lexicalMatches, ...semanticMatches];

  if (lexicalMatches.length > 0 && weights.lexical > 0) {
    rankedLists.push(
      buildRankedList(
        lexicalMatches,
        weights.lexical,
        (a, b) => {
          if (b.lexical_score !== a.lexical_score) {
            return b.lexical_score - a.lexical_score;
          }
          return a.chunk_id.localeCompare(b.chunk_id);
        },
        (value) => value.chunk_id
      )
    );
  }

  if (semanticMatches.length > 0 && weights.semantic > 0) {
    rankedLists.push(
      buildRankedList(
        semanticMatches,
        weights.semantic,
        (a, b) => {
          if (a.distance !== b.distance) {
            return a.distance - b.distance;
          }
          return a.chunk_id.localeCompare(b.chunk_id);
        },
        (value) => value.chunk_id
      )
    );
  }

  if (lexicalMatches.length > 0 && weights.trigram > 0) {
    rankedLists.push(
      buildRankedList(
        lexicalMatches,
        weights.trigram,
        (a, b) => {
          if (b.trigram_score !== a.trigram_score) {
            return b.trigram_score - a.trigram_score;
          }
          return a.chunk_id.localeCompare(b.chunk_id);
        },
        (value) => value.chunk_id,
        (value) => value.trigram_score > 0
      )
    );
  }

  if (canonicalBoost > 0) {
    const canonicalEntries = combined
      .filter((match) => Boolean(match.canonical_key))
      .sort((a, b) => a.chunk_id.localeCompare(b.chunk_id))
      .map((match, index) => ({ chunk_id: match.chunk_id, rank: index + 1 }));
    if (canonicalEntries.length > 0) {
      rankedLists.push({ weight: canonicalBoost, entries: canonicalEntries });
    }
  }

  if (pinnedBoost > 0) {
    const pinnedEntries = combined
      .filter((match) => Boolean(match.pinned))
      .sort((a, b) => a.chunk_id.localeCompare(b.chunk_id))
      .map((match, index) => ({ chunk_id: match.chunk_id, rank: index + 1 }));
    if (pinnedEntries.length > 0) {
      rankedLists.push({ weight: pinnedBoost, entries: pinnedEntries });
    }
  }

  const meta = new Map<string, FusionMatch>();
  for (const match of combined) {
    if (!meta.has(match.chunk_id)) {
      meta.set(match.chunk_id, {
        chunk_id: match.chunk_id,
        item_id: match.item_id,
        version_id: match.version_id,
        version_num: match.version_num,
        title: match.title,
        kind: match.kind,
        scope: match.scope,
        canonical_key: match.canonical_key,
        pinned: match.pinned,
        tags: match.tags,
        heading_path: match.heading_path,
        section_anchor: match.section_anchor,
        excerpt: match.excerpt,
        score: 0,
      });
    }
  }

  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (const entry of list.entries) {
      const score = list.weight / (k + entry.rank);
      scores.set(entry.chunk_id, (scores.get(entry.chunk_id) ?? 0) + score);
    }
  }

  for (const [chunkId, match] of meta.entries()) {
    match.score = scores.get(chunkId) ?? 0;
  }

  return Array.from(meta.values()).sort(defaultTieBreak);
}
