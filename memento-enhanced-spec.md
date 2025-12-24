# Memento MCP Memory Server: Enhanced Specification

## Executive Summary

This document enhances the original Memento MCP Memory Server specification with detailed technical implementations derived from current best practices in pgvector, hybrid search, embedding providers, and MCP server architecture.

---

## Part 1: pgvector HNSW Index Optimization

### Understanding HNSW Architecture

HNSW (Hierarchical Navigable Small World) indexes in pgvector work through a layered graph structure where the top layer contains a sparse sampling of data points, and each successive layer becomes progressively denser. When searching, the algorithm starts at the top layer, finds the nearest neighbors, then uses those as entry points to navigate through denser layers until reaching the bottom layer with all data points.

### Critical HNSW Parameters

**The `m` parameter** controls the maximum number of connections (edges) per node at each layer. According to the original HNSW paper, a reasonable range is 5-48, with 16 being a common default. Lower values of `m` work better for lower-dimensional data and lower recall requirements, while higher values improve accuracy for high-dimensional embeddings (like 1024-2048 dimension vectors from Voyage/Jina).

**The `ef_construction` parameter** determines the candidate list size during index building. It controls the trade-off between index build time and quality. The constraint `ef_construction >= 2 * m` must be satisfied. Higher values lead to better-quality indexes but significantly longer build times with diminishing returns beyond a certain point.

**The `ef_search` parameter** (set at query time) controls the candidate list size during search operations. The default is 40, which limits maximum returned results to 40. For the memory server's restore bundles that may need more than 40 items, this must be increased dynamically.

### Enhanced Schema for HNSW Indexes

```sql
-- Create per-profile HNSW indexes with optimized parameters for embedding dimensions
-- For 1024-dimensional Voyage embeddings:
CREATE INDEX chunk_embeddings_hnsw_voyage_1024
  ON chunk_embeddings 
  USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_profile_id = 'voyage-context-3-profile-uuid';

-- For 768-dimensional Jina v3 embeddings:
CREATE INDEX chunk_embeddings_hnsw_jina_768
  ON chunk_embeddings 
  USING hnsw ((embedding::vector(768)) vector_cosine_ops)
  WITH (m = 12, ef_construction = 48)
  WHERE embedding_profile_id = 'jina-v3-profile-uuid';
```

### Memory Requirements and Performance Considerations

HNSW indexes are most efficient when kept entirely in memory. For production deployments:

1. **Index size estimation**: Indexes for 1M rows of AI embeddings can reach 8GB or larger
2. **RAM allocation**: Ensure sufficient `shared_buffers` and `effective_cache_size` to keep indexes resident
3. **Build requirements**: Index building requires substantial `maintenance_work_mem` (often 1-2GB for large datasets)
4. **Query optimization**: Always verify index usage with `EXPLAIN ANALYZE`; complex CTEs or joins may bypass HNSW indexes

### Query Pattern That Uses HNSW Index

```sql
-- CORRECT: Subquery pattern that uses HNSW index
SELECT r.id, r.title
FROM memory_chunks mc
JOIN memory_versions mv ON mc.version_id = mv.id
WHERE mv.item_id != excluded_item_id
ORDER BY mc.embedding <-> (
  SELECT embedding FROM chunk_embeddings 
  WHERE chunk_id = reference_chunk_id
)
LIMIT 20;

-- INCORRECT: Join pattern that may not use index
SELECT r1.id FROM chunks r0, chunks r1
WHERE r0.id = 142508 AND r1.id != r0.id
ORDER BY r0.embedding <-> r1.embedding LIMIT 1;
```

### Dynamic ef_search Adjustment

```typescript
// In the search handler, adjust ef_search based on requested limit
async function searchWithDynamicEf(
  query: string, 
  limit: number,
  pool: Pool
): Promise<SearchResult[]> {
  const efSearch = Math.max(40, limit * 2); // Ensure sufficient candidates
  
  await pool.query(`SET LOCAL hnsw.ef_search = $1`, [efSearch]);
  
  const result = await pool.query(`
    SELECT id, chunk_text, 1 - (embedding <=> $1::vector) as similarity
    FROM chunk_embeddings ce
    JOIN memory_chunks mc ON ce.chunk_id = mc.id
    WHERE ce.embedding_profile_id = $2
    ORDER BY ce.embedding <=> $1::vector
    LIMIT $3
  `, [queryEmbedding, profileId, limit]);
  
  return result.rows;
}
```

---

## Part 2: Hybrid Search with BM25 and Reciprocal Rank Fusion

### Why Native Postgres FTS Falls Short

PostgreSQL's built-in `ts_rank` function evaluates documents in isolation without corpus-level statistics. When ranking results, it cannot distinguish between common terms (appearing in 80% of documents) and rare, discriminating terms (appearing in 5%). This limitation makes it unsuitable for high-precision RAG retrieval where term specificity matters.

### BM25 Implementation Strategy

BM25 combines three signals for superior lexical ranking:

1. **Term Frequency (TF)** with saturation: Diminishing returns prevent keyword stuffing
2. **Inverse Document Frequency (IDF)**: Rare terms receive higher weight
3. **Document Length Normalization**: Shorter, focused documents preferred over long documents with incidental mentions

### ParadeDB pg_search Integration

When pg_search is available, create a BM25 index alongside the existing tsvector:

```sql
-- Install pg_search extension
CREATE EXTENSION IF NOT EXISTS pg_search;

-- Create BM25 index on memory_chunks
CREATE INDEX idx_chunks_bm25 ON memory_chunks
USING bm25 (
  id,
  chunk_text::pdb.simple('stemmer=english')
)
WITH (key_field=id);

-- Query using BM25 scoring
SELECT id, chunk_text, pdb.score(id) AS bm25_score
FROM memory_chunks
WHERE chunk_text ||| $1::text  -- Match disjunction operator
ORDER BY bm25_score DESC
LIMIT 40;
```

### Hybrid Search with Reciprocal Rank Fusion (RRF)

RRF elegantly combines rankings from different search systems without requiring score normalization. The formula computes: `RRF(document) = Σ 1/(k + rank_i(document))` where `k` is typically 60.

```sql
-- Complete hybrid search implementation
WITH
-- BM25 lexical search with pg_search (or fallback to tsvector)
fulltext AS (
  SELECT 
    mc.id,
    ROW_NUMBER() OVER (ORDER BY pdb.score(mc.id) DESC) AS r
  FROM memory_chunks mc
  WHERE mc.chunk_text ||| $1::text
  LIMIT 40
),

-- Semantic vector search
semantic AS (
  SELECT 
    mc.id,
    ROW_NUMBER() OVER (ORDER BY ce.embedding <=> $2::vector) AS r
  FROM chunk_embeddings ce
  JOIN memory_chunks mc ON ce.chunk_id = mc.id
  WHERE ce.embedding_profile_id = $3
  LIMIT 40
),

-- Trigram boost for exact code tokens (identifiers, stack traces)
trigram AS (
  SELECT 
    mc.id,
    ROW_NUMBER() OVER (ORDER BY similarity(mc.chunk_text, $4) DESC) AS r
  FROM memory_chunks mc
  WHERE mc.chunk_text % $4  -- trigram similarity operator
  LIMIT 20
),

-- Compute RRF with weighted contributions
rrf AS (
  SELECT id, 0.4 * (1.0 / (60 + r)) AS s FROM fulltext
  UNION ALL
  SELECT id, 0.5 * (1.0 / (60 + r)) AS s FROM semantic
  UNION ALL
  SELECT id, 0.1 * (1.0 / (60 + r)) AS s FROM trigram
)

-- Aggregate scores and join back to full data
SELECT 
  mi.id AS item_id,
  mi.title,
  mi.kind,
  mi.is_canonical,
  mc.heading_path,
  mc.section_anchor,
  SUBSTRING(mc.chunk_text, 1, 300) AS excerpt,
  SUM(rrf.s) AS score
FROM rrf
JOIN memory_chunks mc ON rrf.id = mc.id
JOIN memory_versions mv ON mc.version_id = mv.id
JOIN memory_items mi ON mv.item_id = mi.id
WHERE mi.project_id = $5
  AND mi.status = 'active'
GROUP BY mi.id, mi.title, mi.kind, mi.is_canonical, 
         mc.id, mc.heading_path, mc.section_anchor, mc.chunk_text
ORDER BY score DESC
LIMIT $6;
```

### Weighted RRF for Different Use Cases

```typescript
// Configurable weights based on query characteristics
interface RRFWeights {
  lexical: number;   // BM25/tsvector contribution
  semantic: number;  // Vector similarity contribution  
  trigram: number;   // Exact token match contribution
}

const WEIGHT_PROFILES: Record<string, RRFWeights> = {
  // Technical documentation: favor exact term matching
  'technical': { lexical: 0.5, semantic: 0.35, trigram: 0.15 },
  
  // Natural language queries: favor semantic understanding
  'conversational': { lexical: 0.25, semantic: 0.7, trigram: 0.05 },
  
  // Code search: emphasize trigram for identifiers
  'code': { lexical: 0.3, semantic: 0.3, trigram: 0.4 },
  
  // Default balanced
  'default': { lexical: 0.4, semantic: 0.5, trigram: 0.1 }
};
```

### Boosting Canonical Documents

Canonical documents (app specs, feature specs, implementation plans) should receive preferential ranking. Implement this as a virtual rank boost in the RRF computation:

```sql
-- Add canonical boost in RRF calculation
canonical_boost AS (
  SELECT 
    mc.id,
    CASE WHEN mi.is_canonical THEN 1 ELSE 1000 END AS virtual_rank
  FROM memory_chunks mc
  JOIN memory_versions mv ON mc.version_id = mv.id
  JOIN memory_items mi ON mv.item_id = mi.id
  WHERE mi.project_id = $5
),

-- Include canonical boost in final RRF
rrf AS (
  SELECT id, 0.4 * (1.0 / (60 + r)) AS s FROM fulltext
  UNION ALL
  SELECT id, 0.5 * (1.0 / (60 + r)) AS s FROM semantic
  UNION ALL
  SELECT id, 0.1 * (1.0 / (60 + r)) AS s FROM trigram
  UNION ALL
  SELECT id, 0.15 * (1.0 / (60 + virtual_rank)) AS s FROM canonical_boost
)
```

---

## Part 3: Embedding Provider Implementation

### Voyage AI Integration

Voyage AI provides two key embedding endpoints relevant to this specification:

#### Standard Embeddings (voyage-3-large)
For ad-hoc notes, session snapshots, and quick retrieval:

```typescript
interface VoyageEmbedRequest {
  input: string[];
  model: 'voyage-3-large' | 'voyage-code-3' | 'voyage-3';
  input_type?: 'query' | 'document';
  output_dimension?: 256 | 512 | 1024 | 2048; // MRL support
  output_dtype?: 'float' | 'int8' | 'uint8' | 'binary' | 'ubinary';
}

async function embedWithVoyage(
  texts: string[],
  inputType: 'query' | 'document',
  config: VoyageConfig
): Promise<number[][]> {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: texts,
      model: config.model || 'voyage-3-large',
      input_type: inputType,
      output_dimension: config.dimensions || 1024
    })
  });
  
  const data = await response.json();
  return data.data.map((d: any) => d.embedding);
}
```

#### Contextualized Chunk Embeddings (voyage-context-3)
For canonical documents where chunk context is critical:

```typescript
interface VoyageContextualizedRequest {
  inputs: string[][]; // Array of document chunk arrays
  model: 'voyage-context-3';
  input_type?: 'query' | 'document';
  output_dimension?: 256 | 512 | 1024 | 2048;
}

async function embedCanonicalDocument(
  chunks: string[],
  config: VoyageConfig
): Promise<number[][]> {
  // Voyage's contextualized embeddings process all chunks together
  // Each chunk embedding incorporates context from sibling chunks
  // IMPORTANT: Do NOT use overlapping chunks with this endpoint
  
  const response = await fetch(
    'https://api.voyageai.com/v1/contextualizedembeddings',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: [chunks], // Wrap in array - each inner array is one document
        model: 'voyage-context-3',
        input_type: 'document',
        output_dimension: config.dimensions || 1024
      })
    }
  );
  
  const data = await response.json();
  return data.results[0].embeddings;
}
```

The key insight from Voyage's contextualized embeddings: when chunks lose their surrounding context (e.g., "The company's revenue increased by 15%" without knowing which company), standard embeddings rank them poorly. Contextualized embeddings encode the full document context into each chunk vector, dramatically improving retrieval for such cases.

### Jina AI Integration

Jina provides powerful multilingual embeddings with optional late chunking:

#### Standard Embeddings (jina-embeddings-v3)

```typescript
interface JinaEmbedRequest {
  input: string[];
  model: 'jina-embeddings-v3';
  task?: 'retrieval.query' | 'retrieval.passage' | 'classification' | 
         'text-matching' | 'separation';
  dimensions?: number; // Matryoshka support: 32-1024
  late_chunking?: boolean;
}

async function embedWithJina(
  texts: string[],
  task: 'retrieval.query' | 'retrieval.passage',
  config: JinaConfig
): Promise<number[][]> {
  const response = await fetch('https://api.jina.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: texts,
      model: 'jina-embeddings-v3',
      task: task,
      dimensions: config.dimensions || 1024
    })
  });
  
  const data = await response.json();
  return data.data.map((d: any) => d.embedding);
}
```

#### Late Chunking for Contextual Embeddings

Jina's late chunking applies the transformer to the entire document first, generating token-level embeddings that incorporate full document context. Mean pooling is then applied to each chunk's token range, producing chunk embeddings that are "conditioned on" surrounding content rather than being independent (i.i.d.).

```typescript
async function embedWithLateChunking(
  fullDocument: string,
  chunkBoundaries: Array<{start: number, end: number}>,
  config: JinaConfig
): Promise<number[][]> {
  // Send the full document with late_chunking enabled
  // Jina will process the entire document through the transformer
  // then pool embeddings according to provided boundaries
  
  const response = await fetch('https://api.jina.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: [fullDocument],
      model: 'jina-embeddings-v3',
      task: 'retrieval.passage',
      late_chunking: true,
      // Chunk boundaries are derived from input structure
      // Jina uses sentence/paragraph boundaries automatically
    })
  });
  
  return response.json();
}
```

### OpenAI-Compatible Local Embedders

Support for local models (Snowflake Arctic, sentence-transformers) via OpenAI-compatible APIs:

```typescript
interface OpenAICompatConfig {
  baseUrl: string;  // e.g., 'http://localhost:8080/v1'
  apiKey?: string;  // Optional for local servers
  model: string;    // e.g., 'arctic-embed-l'
}

async function embedWithLocalServer(
  texts: string[],
  config: OpenAICompatConfig
): Promise<number[][]> {
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey && { 'Authorization': `Bearer ${config.apiKey}` })
    },
    body: JSON.stringify({
      input: texts,
      model: config.model
    })
  });
  
  const data = await response.json();
  return data.data.map((d: any) => d.embedding);
}
```

### Unified Embedder Interface

```typescript
type EmbedderProvider = 'voyage' | 'jina' | 'openai_compat';

interface EmbedRequest {
  texts: string[];
  inputType: 'query' | 'document';
  contextual?: boolean;  // Use contextualized/late-chunking if available
}

interface EmbedResponse {
  vectors: number[][];
  dimensions: number;
  provider: EmbedderProvider;
  model: string;
  tokensUsed?: number;
}

interface Embedder {
  embed(req: EmbedRequest): Promise<EmbedResponse>;
  embedContextual?(chunks: string[]): Promise<EmbedResponse>; // For canonical docs
  health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}

class EmbedderFactory {
  static create(profile: EmbeddingProfile): Embedder {
    switch (profile.provider) {
      case 'voyage':
        return new VoyageEmbedder(profile);
      case 'jina':
        return new JinaEmbedder(profile);
      case 'openai_compat':
        return new OpenAICompatEmbedder(profile);
      default:
        throw new Error(`Unknown provider: ${profile.provider}`);
    }
  }
}
```

---

## Part 4: Structure-Preserving Markdown Chunking

### The "Lost Context" Problem

When documents are naively chunked by character count or sentence boundaries, anaphoric references lose their antecedents. A chunk containing "The city has a population of 3.85 million" becomes ambiguous without knowing "the city" refers to Berlin from an earlier chunk. Structure-preserving chunking with heading path tracking solves this.

### Chunking Algorithm

```typescript
interface ChunkMetadata {
  chunkIndex: number;
  chunkText: string;
  headingPath: string[];      // ["App Spec", "Authentication", "Token Refresh"]
  sectionAnchor: string;      // "h2:authentication.token-refresh"
  startChar: number;
  endChar: number;
  tokenEstimate: number;
}

interface ChunkingConfig {
  targetTokens: number;       // 600
  maxTokens: number;          // 800 (hard cap)
  overlapTokens: number;      // 60 (within same heading path only)
  preserveCodeBlocks: boolean;
  preserveTables: boolean;
}

function chunkMarkdown(
  markdown: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): ChunkMetadata[] {
  const blocks = parseMarkdownToBlocks(markdown);
  const chunks: ChunkMetadata[] = [];
  
  let currentChunk: string[] = [];
  let currentTokens = 0;
  let headingStack: string[] = [];
  let chunkStartChar = 0;
  
  for (const block of blocks) {
    // Update heading stack for heading blocks
    if (block.type === 'heading') {
      // Pop headings at same or higher level
      while (headingStack.length >= block.level) {
        headingStack.pop();
      }
      headingStack.push(block.text);
      
      // Force chunk boundary at heading if current chunk is non-trivial
      if (currentTokens > config.targetTokens * 0.3) {
        finalizeChunk();
      }
    }
    
    // Never split code blocks or tables
    if (block.type === 'code_fence' && config.preserveCodeBlocks) {
      if (currentTokens + block.tokens > config.maxTokens) {
        finalizeChunk();
      }
      currentChunk.push(block.raw);
      currentTokens += block.tokens;
      continue;
    }
    
    // Check if adding this block exceeds target
    if (currentTokens + block.tokens > config.targetTokens) {
      // If exceeds max, must split
      if (currentTokens + block.tokens > config.maxTokens) {
        if (currentChunk.length > 0) {
          finalizeChunk();
        }
        // Handle oversized block by sentence splitting
        if (block.tokens > config.maxTokens) {
          splitBlockBySentences(block);
          continue;
        }
      }
    }
    
    currentChunk.push(block.raw);
    currentTokens += block.tokens;
  }
  
  // Finalize any remaining content
  if (currentChunk.length > 0) {
    finalizeChunk();
  }
  
  return chunks;
  
  function finalizeChunk() {
    const text = currentChunk.join('\n\n');
    chunks.push({
      chunkIndex: chunks.length,
      chunkText: text,
      headingPath: [...headingStack],
      sectionAnchor: generateSectionAnchor(headingStack),
      startChar: chunkStartChar,
      endChar: chunkStartChar + text.length,
      tokenEstimate: currentTokens
    });
    
    chunkStartChar += text.length;
    currentChunk = [];
    currentTokens = 0;
    
    // Add overlap from previous chunk if within same heading
    // (Implementation omitted for brevity)
  }
}
```

### Section Anchor Generation

Stable, deterministic anchors enable precise section retrieval across document versions:

```typescript
function generateSectionAnchor(headingPath: string[]): string {
  if (headingPath.length === 0) return 'root';
  
  const level = headingPath.length;
  const slugs = headingPath.map(heading => 
    heading
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 40)
  );
  
  return `h${level}:${slugs.join('.')}`;
}

// Examples:
// ["App Spec", "Auth", "Token Refresh"] -> "h3:app-spec.auth.token-refresh"
// ["Implementation Plan"] -> "h1:implementation-plan"
```

### Token Estimation (Fast Path)

```typescript
// Fast heuristic: ~4 chars per token for English text
function estimateTokensFast(text: string): number {
  return Math.ceil(text.length / 4);
}

// Precise counting (only when near boundary)
function estimateTokensPrecise(text: string, tokenizer: Tokenizer): number {
  return tokenizer.encode(text).length;
}

// Hybrid approach
function estimateTokens(
  text: string, 
  tokenizer: Tokenizer,
  nearBoundary: boolean
): number {
  if (nearBoundary) {
    return estimateTokensPrecise(text, tokenizer);
  }
  return estimateTokensFast(text);
}
```

---

## Part 5: MCP Server Implementation Details

### Critical STDIO Transport Constraints

For STDIO-based MCP servers, the most critical rule is: **never write to stdout**. The JSON-RPC protocol uses stdout exclusively for message transport. Any logging, debug output, or stray console.log/print statements will corrupt the protocol stream.

```typescript
// WRONG - breaks STDIO transport
console.log('Processing request');

// CORRECT - use stderr for logging
console.error('Processing request');

// BETTER - use a proper logging library
import { Logger } from './logger';
const log = Logger.child({ module: 'mcp-server' });
log.info('Processing request'); // Configured to write to stderr/file
```

### Server Architecture

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'memento',
  version: '1.0.0'
});

// Register tools with Zod schemas for validation
server.registerTool(
  'memory.commit',
  {
    description: 'Commit memory items with idempotency guarantees',
    inputSchema: {
      idempotencyKey: z.string().uuid(),
      entries: z.array(z.object({
        kind: z.enum(['spec', 'plan', 'decision', 'troubleshooting', 'note']),
        title: z.string(),
        content: z.string(),
        canonicalKey: z.string().optional(),
        tags: z.array(z.string()).optional()
      })),
      sessionId: z.string().uuid().optional()
    }
  },
  async ({ idempotencyKey, entries, sessionId }) => {
    // Implementation...
  }
);
```

### Tool Registration Pattern

```typescript
// Canonical document tools
server.registerTool('canonical.upsert', {
  description: 'Create or update a canonical document (spec, plan)',
  inputSchema: {
    canonicalKey: z.string().describe('Stable identifier, e.g. "app" or "feature/auth"'),
    docClass: z.enum(['app_spec', 'feature_spec', 'implementation_plan']),
    title: z.string(),
    contentMarkdown: z.string(),
    tags: z.array(z.string()).optional(),
    idempotencyKey: z.string().uuid()
  }
}, canonicalUpsertHandler);

server.registerTool('canonical.get', {
  description: 'Retrieve a canonical document by key',
  inputSchema: {
    canonicalKey: z.string(),
    versionNum: z.number().int().positive().optional()
  }
}, canonicalGetHandler);

server.registerTool('canonical.outline', {
  description: 'Get the section structure of a canonical document',
  inputSchema: {
    canonicalKey: z.string(),
    versionNum: z.number().int().positive().optional()
  }
}, canonicalOutlineHandler);

server.registerTool('canonical.get_section', {
  description: 'Get a specific section by anchor',
  inputSchema: {
    canonicalKey: z.string(),
    sectionAnchor: z.string()
  }
}, canonicalGetSectionHandler);

server.registerTool('canonical.context_pack', {
  description: 'Build a context pack of relevant sections for a goal',
  inputSchema: {
    canonicalKey: z.string(),
    goal: z.string(),
    maxChars: z.number().int().positive().default(8000)
  }
}, canonicalContextPackHandler);

// Search and restore tools
server.registerTool('memory.search', {
  description: 'Hybrid semantic + lexical search across project memory',
  inputSchema: {
    query: z.string(),
    kinds: z.array(z.enum(['spec', 'plan', 'decision', 'troubleshooting', 'note'])).optional(),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(20)
  }
}, memorySearchHandler);

server.registerTool('memory.restore', {
  description: 'Produce a deterministic context bundle for session bootstrap',
  inputSchema: {
    goal: z.string().optional(),
    kinds: z.array(z.string()).optional(),
    maxItems: z.number().int().default(12),
    maxChars: z.number().int().default(30000),
    includeCanonical: z.boolean().default(true),
    includeRecentTroubleshooting: z.boolean().default(true)
  }
}, memoryRestoreHandler);
```

### Resource Registration

```typescript
// Expose memory items as browsable resources
server.registerResourceList(async ({ projectId }) => {
  const items = await db.query(`
    SELECT id, title, kind, canonical_key, updated_at
    FROM memory_items
    WHERE project_id = $1 AND status = 'active'
    ORDER BY pinned DESC, updated_at DESC
    LIMIT 100
  `, [projectId]);
  
  return items.rows.map(item => ({
    uri: `memento://items/${item.id}`,
    name: item.title,
    mimeType: 'text/markdown',
    description: `${item.kind}${item.canonical_key ? ` (${item.canonical_key})` : ''}`
  }));
});

server.registerResourceRead(async (uri) => {
  const itemId = uri.replace('memento://items/', '');
  const version = await db.query(`
    SELECT mv.content_text, mi.title, mi.kind
    FROM memory_versions mv
    JOIN memory_items mi ON mv.item_id = mi.id
    WHERE mi.id = $1
    ORDER BY mv.version_num DESC
    LIMIT 1
  `, [itemId]);
  
  return {
    contents: [{
      uri,
      mimeType: 'text/markdown',
      text: version.rows[0].content_text
    }]
  };
});
```

---

## Part 6: Worker Architecture for Async Processing

### Outbox Pattern Implementation

```typescript
// Outbox event types
type OutboxEventType = 
  | 'INGEST_VERSION'   // Parse, chunk, populate tsvector
  | 'EMBED_VERSION'    // Generate embeddings for chunks
  | 'REINDEX_PROFILE'  // Re-embed all chunks for a profile
  | 'REBUILD_BM25';    // Rebuild BM25 index

interface OutboxEvent {
  id: string;
  projectId: string;
  eventType: OutboxEventType;
  payload: Record<string, any>;
  createdAt: Date;
  processedAt: Date | null;
  error: string | null;
  retryCount: number;
}

// Worker polling loop with FOR UPDATE SKIP LOCKED
async function processOutboxEvents(pool: Pool): Promise<void> {
  while (true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Claim up to 10 unprocessed events
      const events = await client.query<OutboxEvent>(`
        SELECT * FROM outbox_events
        WHERE processed_at IS NULL
          AND (error IS NULL OR retry_count < 3)
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 10
      `);
      
      for (const event of events.rows) {
        try {
          await processEvent(event, client);
          
          await client.query(`
            UPDATE outbox_events
            SET processed_at = NOW()
            WHERE id = $1
          `, [event.id]);
        } catch (err) {
          await client.query(`
            UPDATE outbox_events
            SET error = $1, retry_count = retry_count + 1
            WHERE id = $2
          `, [err.message, event.id]);
        }
      }
      
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    
    // Brief pause between polling cycles
    await sleep(100);
  }
}
```

### Event Handlers

```typescript
async function processEvent(
  event: OutboxEvent, 
  client: PoolClient
): Promise<void> {
  switch (event.eventType) {
    case 'INGEST_VERSION':
      await handleIngestVersion(event.payload, client);
      break;
    case 'EMBED_VERSION':
      await handleEmbedVersion(event.payload, client);
      break;
    case 'REINDEX_PROFILE':
      await handleReindexProfile(event.payload, client);
      break;
    default:
      throw new Error(`Unknown event type: ${event.eventType}`);
  }
}

async function handleIngestVersion(
  payload: { versionId: string },
  client: PoolClient
): Promise<void> {
  // 1. Fetch version content
  const version = await client.query(`
    SELECT id, content_text, content_format
    FROM memory_versions
    WHERE id = $1
  `, [payload.versionId]);
  
  // 2. Normalize to markdown if needed
  const markdown = normalizeToMarkdown(
    version.rows[0].content_text,
    version.rows[0].content_format
  );
  
  // 3. Chunk with structure preservation
  const chunks = chunkMarkdown(markdown, DEFAULT_CHUNKING_CONFIG);
  
  // 4. Insert chunks with tsvector
  for (const chunk of chunks) {
    await client.query(`
      INSERT INTO memory_chunks (
        version_id, chunk_index, chunk_text,
        heading_path, section_anchor, start_char, end_char,
        tsv
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        to_tsvector('english', $3)
      )
    `, [
      payload.versionId,
      chunk.chunkIndex,
      chunk.chunkText,
      chunk.headingPath,
      chunk.sectionAnchor,
      chunk.startChar,
      chunk.endChar
    ]);
  }
}

async function handleEmbedVersion(
  payload: { versionId: string; profileId: string; contextual?: boolean },
  client: PoolClient
): Promise<void> {
  // 1. Fetch profile and chunks
  const profile = await getEmbeddingProfile(payload.profileId, client);
  const chunks = await client.query(`
    SELECT id, chunk_text FROM memory_chunks
    WHERE version_id = $1
    ORDER BY chunk_index
  `, [payload.versionId]);
  
  // 2. Create embedder
  const embedder = EmbedderFactory.create(profile);
  
  // 3. Generate embeddings
  let embeddings: number[][];
  if (payload.contextual && embedder.embedContextual) {
    // Use contextualized embeddings for canonical docs
    embeddings = (await embedder.embedContextual(
      chunks.rows.map(c => c.chunk_text)
    )).vectors;
  } else {
    // Standard embeddings
    embeddings = (await embedder.embed({
      texts: chunks.rows.map(c => c.chunk_text),
      inputType: 'document'
    })).vectors;
  }
  
  // 4. Store embeddings
  for (let i = 0; i < chunks.rows.length; i++) {
    await client.query(`
      INSERT INTO chunk_embeddings (chunk_id, embedding_profile_id, embedding)
      VALUES ($1, $2, $3::vector)
      ON CONFLICT (chunk_id, embedding_profile_id) 
      DO UPDATE SET embedding = EXCLUDED.embedding
    `, [chunks.rows[i].id, payload.profileId, JSON.stringify(embeddings[i])]);
  }
}
```

---

## Part 7: Observability and Operational Concerns

### Metrics to Track

```typescript
import { Counter, Histogram, Gauge } from 'prom-client';

// Outbox metrics
const outboxBacklog = new Gauge({
  name: 'memento_outbox_backlog_total',
  help: 'Number of unprocessed outbox events',
  labelNames: ['event_type']
});

const eventProcessingDuration = new Histogram({
  name: 'memento_event_processing_seconds',
  help: 'Time to process outbox events',
  labelNames: ['event_type', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30]
});

// Embedding metrics
const embedderLatency = new Histogram({
  name: 'memento_embedder_latency_seconds',
  help: 'Embedding API call latency',
  labelNames: ['provider', 'model'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5]
});

const embedderErrors = new Counter({
  name: 'memento_embedder_errors_total',
  help: 'Embedding API errors',
  labelNames: ['provider', 'error_type']
});

// Search metrics
const searchLatency = new Histogram({
  name: 'memento_search_latency_seconds',
  help: 'Search operation latency',
  labelNames: ['search_type'], // 'hybrid', 'semantic', 'lexical'
  buckets: [0.05, 0.1, 0.25, 0.5, 1]
});
```

### Structured Logging

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { destination: 2 } // stderr for STDIO compatibility
  }
});

// Create child loggers with correlation IDs
function createRequestLogger(requestId: string, commitId?: string) {
  return logger.child({
    requestId,
    commitId,
    service: 'memento-mcp'
  });
}
```

---

## Part 8: Configuration Recommendations

### Default Chunking Configuration

```typescript
const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  targetTokens: 600,
  maxTokens: 800,
  overlapTokens: 60,  // Only within same heading path
  preserveCodeBlocks: true,
  preserveTables: true
};
```

### Default Search Configuration

```typescript
const DEFAULT_SEARCH_CONFIG = {
  lexicalTopK: 40,
  semanticTopK: 40,
  trigramTopK: 20,
  rrf: {
    k: 60,
    weights: {
      lexical: 0.4,
      semantic: 0.5,
      trigram: 0.1
    },
    canonicalBoostWeight: 0.15
  }
};
```

### Default Restore Bundle Configuration

```typescript
const DEFAULT_RESTORE_CONFIG = {
  maxItems: 12,
  maxChars: 30000,
  includePinnedCanonical: true,
  includeLatestSnapshot: true,
  recentTroubleshootingDays: 30,
  recentTroubleshootingLimit: 5
};
```

---

## Part 9: Implementation Milestones (Revised)

### Milestone 1: Core Database + Domain Primitives (Week 1-2)
- Complete schema migrations with all tables
- Project resolution logic (git remote hash or path hash)
- Idempotent commit handling with proper deduplication
- Unit tests for idempotency guarantees

### Milestone 2: MCP Server Tool Surface (Week 2-3)
- STDIO transport with proper stderr logging
- All tool registrations with Zod schemas
- Resource listing and reading
- Integration tests with MCP Inspector

### Milestone 3: Chunking + Sparse Indexing (Week 3-4)
- Markdown parser with heading stack tracking
- Structure-preserving chunker
- tsvector population
- Trigram index for code tokens
- Property-based tests for chunking invariants

### Milestone 4: Embedding Pipeline (Week 4-5)
- Voyage AI client with standard + contextualized modes
- Jina AI client with late chunking support
- OpenAI-compatible local embedder
- Embedding profile management
- Dynamic HNSW index creation per profile

### Milestone 5: Hybrid Search (Week 5-6)
- BM25 integration (pg_search) with fallback to tsvector
- RRF implementation with configurable weights
- Canonical document boosting
- Search latency optimization
- Regression test suite for ranking quality

### Milestone 6: Canonical Docs + Context Packs (Week 6-7)
- Section anchor generation and persistence
- Outline extraction API
- Deterministic section retrieval
- Goal-driven context pack assembly
- Golden file tests for restore bundles

### Milestone 7: Operational Polish (Week 7-8)
- Prometheus metrics integration
- Structured logging with correlation IDs
- Dead letter handling for failed events
- Admin tools (reindex, reingest)
- Health check endpoints
- Documentation and runbooks

---

## Appendix A: Complete SQL Migration

See `migrations/001_initial_schema.sql` for the complete, production-ready schema incorporating all tables, indexes, and constraints from this specification.

## Appendix B: Zod Schema Definitions

See `packages/shared/src/schemas.ts` for complete TypeScript/Zod definitions for all tool inputs and outputs.

## Appendix C: Test Fixtures

See `tests/fixtures/` for golden test cases including:
- Chunking test documents with expected outputs
- Search ranking test queries with expected orderings
- Restore bundle test scenarios
