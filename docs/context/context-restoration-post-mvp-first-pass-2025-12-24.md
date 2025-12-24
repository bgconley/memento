# Context Restoration Document — Memento Post‑MVP “Delta Plan” (First Pass)

## Session Snapshot
This repository (`/Users/brennanconley/vibecode/memento`) is an MCP (Model Context Protocol) “memory server” scaffold with a Postgres+pgvector storage layer, a worker that ingests/chunks/embeds content via an outbox pattern, and an STDIO MCP server exposing tools and prompts. In this session we began implementing the **first pass post‑MVP improvements** (“delta plan”) on top of the existing schemas/tools/worker/search design: HNSW tuning controls, hybrid fusion upgrades, contextual embeddings for canonical docs, MCP resources (list/read), outbox retry/backoff hardening, and an optional BM25 lane.

**State of the world at end‑of‑session:** All modified packages compile successfully (`pnpm -r build` passes). New functionality is implemented in code, but there has not been a full end‑to‑end runtime validation in a live database with real embeddings in this session (beyond compilation). A new SQL migration was added for outbox retries/backoff and must be applied before running the worker with the new retry logic.

## Core Objectives and Non‑Objectives

### Objectives (what success looks like)
- Per‑embedding‑profile pgvector HNSW index parameters are configurable (via `embedding_profiles.provider_config.hnsw`) and correctly applied to per‑profile HNSW indexes.
- Semantic search dynamically sets `hnsw.ef_search` per query using `SET LOCAL` inside a transaction on the same DB connection.
- Hybrid search fusion supports internal weight profiles, includes a distinct trigram channel, and applies deterministic canonical/pinned boosts without changing public tool schemas.
- Canonical docs (app specs, feature specs, implementation plans) can be embedded with contextual strategies:
  - Voyage contextualized chunk embedding endpoint
  - Jina late‑chunking mode
- MCP server exposes **Resources** (list/read) so clients can browse/read memory items via URIs (not only via tools).
- Worker outbox supports retry/backoff and dead‑letter behavior.
- Optional BM25 (`pg_search`) lane exists behind detection; baseline FTS+trgm remains the default.

### Non‑Objectives (explicitly out of scope for this session)
- Prometheus metrics endpoint (optional improvement) was not implemented.
- A full ranking quality regression suite (golden tests) was not implemented/expanded in this session.
- A full runtime verification (docker compose up + migrations + running MCP server + running worker + validating tool/resource behaviors) was not performed in this session.
- No breaking changes to tool schemas or client‑visible tool names were made (and should not be introduced in follow‑up work).

## Key Decisions and Rationale

1) **Per‑profile HNSW parameters live in `embedding_profiles.provider_config` (no schema migration).**
- Rationale: profile configuration is already JSON; adding structured keys is lightweight and does not require schema churn.
- Alternative considered: add explicit columns (`hnsw_m`, `hnsw_ef_construction`) to `embedding_profiles`.
- Why rejected: migration overhead and reduced flexibility; JSON is sufficient for first pass.

2) **`SET LOCAL hnsw.ef_search` is done via parameter binding within a transaction.**
- Rationale: `SET LOCAL` must apply on the same connection; parameter binding avoids SQL injection and keeps code consistent.
- Alternative considered: inline string interpolation.
- Why rejected: injection risk and less consistent.

3) **Canonical/pinned boost implemented as additional RRF “channels” (ranked lists), not as a constant additive bump.**
- Rationale: constant boosts can dominate score unexpectedly; channel‑based boosts are smaller, rank‑scaled, and deterministic.
- Alternative considered: multiply score (`score *= 1.1`) or constant `+0.1`.
- Why rejected: multiplier can be hard to reason about and constant can overwhelm retrieval.

4) **Contextual embeddings are opt‑in and only applied for canonical doc classes.**
- Rationale: contextual embedding is more expensive and most valuable for canonical specs/plans.
- Alternative considered: contextual embeddings for all content.
- Why rejected: cost/latency and complexity.

5) **BM25 lane is optional and guarded by capability detection.**
- Rationale: `pg_search` is not universally installable; system must work without it.
- Alternative considered: require BM25.
- Why rejected: portability and operational friction.

## Current System Architecture

### Components
- **Postgres DB** (Docker compose is provided): stores projects, sessions, memory items/versions, canonical docs, chunks, embeddings, links, and outbox events.
- **Core library** (`packages/core`): DB access, repositories, chunking, vector index management, search (lexical/semantic/fusion).
- **Clients library** (`packages/clients`): embedder implementations for Voyage, Jina, OpenAI‑compatible endpoints, plus a fake embedder.
- **Worker** (`packages/worker`): outbox poller + job handlers (INGEST_VERSION, EMBED_VERSION, REINDEX_PROFILE).
- **MCP server** (`packages/mcp-server`): STDIO MCP server that registers tools and prompts and now also registers MCP resources.

### Data flow (high‑level)
1. A tool call writes memory via MCP tools (e.g., `memory.commit` or `canonical.upsert`).
2. The write enqueues outbox events.
3. Worker polls outbox:
   - `INGEST_VERSION`: normalize markdown, chunk, compute tsvector, upsert into `memory_chunks`.
   - `EMBED_VERSION`: load chunks, call embedder, store vectors in `chunk_embeddings`.
   - `REINDEX_PROFILE`: (maintenance) triggers re‑embed operations.
4. Search:
   - Lexical lane (FTS+trigram baseline; optional BM25 lane if installed).
   - Semantic lane (pgvector) using dynamic `hnsw.ef_search`.
   - Fusion (RRF) combines lanes + trigram + canonical/pinned boost.

### Mermaid diagram
```mermaid
flowchart LR
  A[MCP Client] -->|tools: memory.commit / canonical.upsert| B[MCP Server (stdio)]
  B -->|SQL writes| C[(Postgres)]
  B -->|enqueue outbox| C

  D[Worker] -->|poll outbox| C
  D -->|INGEST_VERSION| C
  D -->|EMBED_VERSION| E[Embedder Providers]
  E -->|Voyage/Jina/OpenAI-compat| D
  D -->|store embeddings| C

  A -->|tools: memory.search| B
  B -->|lexical search| C
  B -->|semantic search + SET LOCAL hnsw.ef_search| C
  B -->|RRF fusion| B
  B -->|results + resource URIs| A

  A -->|resources/list| B
  A -->|resources/read (memory://...)| B
  B -->|read versions/chunks| C
```

## Repository / Workspace Map

### Root
- `README.md` — scaffold overview and high‑level usage notes.
- `compose.yaml` — Docker compose for Postgres+pgvector.
- `migrations/` — ordered SQL migrations; key tables and indexes.
- `docs/` — usage, troubleshooting, test plan, tool taxonomy.
- `packages/` — workspace packages.

### Packages
- `packages/shared/` — shared Zod schemas, tool registry, logger utilities.
- `packages/core/` — DB layer, repos, chunking, search, vector index manager.
- `packages/clients/` — embedder clients.
- `packages/worker/` — outbox poller and background jobs.
- `packages/mcp-server/` — STDIO MCP server with tool handlers.

### Files modified or added in this session (delta plan implementation)
**Core (`packages/core`)**
- Modified: `packages/core/src/vector/indexManager.ts`
  - Added support for per‑profile HNSW index params (`m`, `ef_construction`) via `options.hnsw`.
  - Added index validation to drop/recreate if HNSW params mismatch.
- Modified: `packages/core/src/search/semantic.ts`
  - Added `provider_config.query` controls for ef_search clamp/min/max/factor.
  - Sets `SET LOCAL hnsw.ef_search = $1` inside the search transaction.
- Modified: `packages/core/src/search/fusion.ts`
  - Canonical/pinned boost now implemented as RRF channels (ranked lists), not constant adds.
- Modified: `packages/core/src/search/search.ts`
  - Added internal “weight profile” selection based on query style heuristics.
- Modified: `packages/core/src/search/lexical.ts`
  - Added optional BM25 lane detection and query path (pg_search extension + bm25 index).

**Clients (`packages/clients`)**
- Modified: `packages/clients/src/embedder.ts`
  - Added optional contextual API: `embedDocumentChunksContextual?(chunks)`.
- Modified: `packages/clients/src/voyage.ts`
  - Added Voyage contextual embeddings endpoint support (`/v1/contextualizedembeddings`).
- Modified: `packages/clients/src/jina.ts`
  - Added configurable late chunking parameter and contextual embedding method.

**Worker (`packages/worker`)**
- Modified: `packages/worker/src/jobs/embedderUtils.ts`
  - Passes `provider_config.late_chunking` into Jina embedder as `lateChunking`.
- Modified: `packages/worker/src/jobs/embedVersion.ts`
  - Detects canonical doc versions and uses contextual embedding when supported.
- Modified: `packages/worker/src/outboxPoller.ts`
  - New retry/backoff logic based on `retry_count` + `next_attempt_at`.
- Modified: `packages/worker/package.json`
  - Added `@types/pg` for TypeScript builds.

**MCP Server (`packages/mcp-server`)**
- Added: `packages/mcp-server/src/resources.ts`
  - Registers MCP resources for listing and reading memory items.
- Modified: `packages/mcp-server/src/main.ts`
  - Calls `registerResources(...)`.
- Modified: `packages/mcp-server/src/handlers.ts`
  - Passes per‑profile HNSW config to `ensureProfileIndex(...)`.

**Migrations**
- Added: `migrations/0013_outbox_retries.sql`
  - Adds `retry_count`, `next_attempt_at`, `locked_at`, `locked_by` and an index.
- Modified: `migrations/0090_optional_bm25_pg_search.sql`
  - Now contains concrete `CREATE EXTENSION pg_search` + `CREATE INDEX ... USING bm25`.

## Implementation State (What Exists Right Now)

### Implemented and compiling
- HNSW index creation supports per‑profile parameters (`m`, `ef_construction`) and checks index definition.
- Semantic search dynamically configures `hnsw.ef_search` using `provider_config.query` fields.
- Hybrid fusion supports:
  - weight profiles inferred from query style
  - trigram lane via `LexicalMatch.trigram_score`
  - canonical/pinned boost as RRF channels
- Contextual embeddings:
  - Voyage embedder implements contextual endpoint.
  - Jina embedder supports late chunking and contextual embedding method.
  - Worker uses contextual embedding for canonical doc classes when enabled.
- MCP resources exist:
  - list resources for recent/pinned items
  - read latest version
  - read version by number
  - read canonical section by anchor (via chunk slicing)
- Outbox retry/backoff:
  - poller only claims ready events
  - exponential backoff with max cap
  - dead‑letters by setting `processed_at` after max retries

### Evidence from this session
- Compilation: `pnpm -r build` executed successfully after fixes.

### Partially implemented / missing
- Chunker overlap controls exist as config fields, but overlap behavior is not implemented in `chunkMarkdown(...)` today (overlapTokens currently has no effect). This means the “disable overlap for contextual embedding” requirement is currently satisfied trivially, but future work may implement overlap logic and then needs contextual coupling.
- No dedicated tests were added in this session for:
  - `SET LOCAL hnsw.ef_search` behavior
  - outbox backoff scheduling correctness
  - MCP resources list/read contract
  - contextual embedding correctness

### Planned but not started (from the delta plan)
- Prometheus metrics (optional) behind `METRICS_PORT` env var.
- Ranking regression tests / golden fixtures for fusion behavior.

## Commands, Environments, and Runtime Assumptions

### Environment assumptions
- OS: macOS (zsh shell).
- Node + pnpm workspace.
- Postgres available via Docker (preferred).

### Install dependencies
```bash
cd /Users/brennanconley/vibecode/memento
pnpm install
```

### Build
```bash
pnpm -r build
```

### Run tests
Each package has its own test script; common patterns:
```bash
pnpm --filter @memento/core test
pnpm --filter @memento/worker test
pnpm --filter @memento/mcp-server test
```

### Run Postgres (docker compose)
```bash
docker compose up -d
```

### Apply migrations
The README suggests applying migrations in order (for local dev):
```bash
for f in migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```
Important: after this session, `migrations/0013_outbox_retries.sql` must be applied for the worker’s new retry logic.

### Run worker
(Exact entrypoint may vary; typical pattern after build)
```bash
pnpm --filter @memento/worker build
node packages/worker/dist/main.js
```

### Run MCP server
```bash
pnpm --filter @memento/mcp-server build
node packages/mcp-server/dist/main.js
```

### Environment variables (high‑signal)
- `DATABASE_URL` — Postgres connection string.
- `EMBEDDER_BASE_URL` — optional override for embedder base URL.
- `EMBEDDER_API_KEY` — embedder API key (do not commit).
- `EMBEDDER_USE_FAKE` — `true` to use deterministic fake embeddings.
- `OUTBOX_LEASE_SECONDS` — worker lease duration.
- `OUTBOX_RETRY_DELAY_SECONDS` — base backoff delay.
- `OUTBOX_RETRY_MAX_DELAY_SECONDS` — max backoff delay.
- `OUTBOX_MAX_ATTEMPTS` — dead‑letter threshold.
- `EMBED_BATCH_SIZE`, `EMBED_CONCURRENCY` — embedding throughput controls.

## Data, Models, and External Dependencies

### Postgres schema overview (Memento)
Key tables (high‑level):
- `workspaces`, `projects` — tenancy and repo context.
- `sessions`, `commits` — audited operations.
- `memory_items`, `memory_versions` — versioned memory content.
- `canonical_docs` — canonical doc registry (ties to `memory_items`).
- `memory_chunks` — chunked text with `tsv` + anchors.
- `chunk_embeddings` — per‑profile embeddings for chunks.
- `embedding_profiles` — embedding provider/model/dims/distance + JSON `provider_config`.
- `outbox_events` — async job queue.

### Embedding providers
- Voyage (`packages/clients/src/voyage.ts`)
  - Standard: `POST /v1/embeddings`
  - Contextual: `POST /v1/contextualizedembeddings`
  - If using contextual embeddings, ensure the embedding profile model matches the contextual model supported by Voyage (e.g., `voyage-context-3`).
- Jina (`packages/clients/src/jina.ts`)
  - `POST /v1/embeddings` with task selection.
  - Late chunking via `late_chunking: true`.
- OpenAI‑compatible local server (`packages/clients/src/openaiCompat.ts`)
- Fake embedder for deterministic tests.

### Embedding profile `provider_config` keys (conventions)
Recommended shape:
```json
{
  "hnsw": { "m": 16, "ef_construction": 64 },
  "query": { "ef_search_min": 40, "ef_search_factor": 2, "ef_search_max": 400 },
  "late_chunking": true,
  "base_url": "https://api.jina.ai",
  "api_key": "..."
}
```
Notes:
- `hnsw` is used by index creation (`ensureProfileIndex`).
- `query.*` is used by semantic search to compute `ef_search`.
- `late_chunking` is used for Jina contextual embeddings (canonical docs only).

### Optional BM25 (`pg_search` / ParadeDB)
- Migration file: `migrations/0090_optional_bm25_pg_search.sql`.
- Runtime detection in code: `packages/core/src/search/lexical.ts`.
- If extension/index is missing, system falls back to FTS+trgm.

### MCP Resources (URIs)
Resources use `memory://` URIs in this first pass:
- `memory://projects/{project_id}/items/{item_id}` — latest item text
- `memory://projects/{project_id}/items/{item_id}/versions/{version_num}` — version text
- `memory://projects/{project_id}/items/{item_id}/sections/{section_anchor}` — section slice (latest)

### Qdrant semantic memory (agent/tooling awareness)
This repo does not implement Qdrant itself, but your agent instructions assume a Qdrant MCP server exists (`qdrant_memory`) used for long‑term semantic memory across sessions.
- Collection naming (per project): `collection_name = "<current_project_id>-mem"`.
- Required metadata fields per item:
  - `project_id`, `environment`, `memory_type`, `source_client`, `author_model`, `created_at`, optional `updated_at`, `scope`, `tags`.
- Separation rule: never read/write across `project_id` boundaries unless explicitly requested.

### Neo4j graph memory (agent/tooling awareness)
This repo does not implement Neo4j, but your agent instructions assume a Neo4j MCP server exists (`neo4j_memory`) used for structured graph memory.
Recommended graph conventions:
- Node labels/types: `Project`, `Decision`, `Plan`, `Task`, `Bug`, `Experiment`, `Summary`, `Constraint`, `Rule`, `Session`.
- Required properties on every node: `project_id`, `environment`, `memory_type`, `source_client`, `author_model`, `created_at` (and `updated_at` as needed).
- Relationship patterns:
  - `(:Project)-[:HAS_DECISION]->(:Decision)`
  - `(:Project)-[:HAS_PLAN]->(:Plan)`
  - `(:Plan)-[:HAS_TASK]->(:Task)`
  - `(:Task)-[:BLOCKED_BY]->(:Bug)`
  - `(:Decision)-[:INFLUENCES]->(:Plan)`
  - `(:Experiment)-[:VALIDATES]->(:Decision)`
- Indexes/constraints (suggested):
  - Unique constraint on `Project(project_id)` within an environment.
  - Index on `:Entity(project_id)` for all labels, or per label if needed.
  - Optional full‑text index for `title` + `description` fields.

## Open Issues, Known Bugs, and Risks

1) **Database migration required for outbox retry/backoff.**
- Symptom if missing: worker queries `retry_count` / `next_attempt_at` columns that do not exist.
- Fix: apply `migrations/0013_outbox_retries.sql`.

2) **Contextual embeddings require correct profile configuration.**
- Voyage contextual embeddings require the correct model and endpoint. Ensure the profile uses a Voyage contextual model (e.g. `voyage-context-3`) if calling `embedDocumentChunksContextual`.
- Jina contextual mode is guarded by `provider_config.late_chunking`; if absent/false, contextual embedding is not used.

3) **BM25 lane is conditional and may fail at runtime.**
- If `pg_search` is installed but query operators differ from assumed (`|||`, `pdb.score`), lexical BM25 may error.
- The implementation attempts to disable BM25 on failure and fall back to FTS.

4) **Chunk overlap is not implemented even though config exposes it.**
- `ChunkingConfig.overlapTokens` exists but is unused in `packages/core/src/chunking/chunker.ts`.
- If overlap behavior is added later, ensure contextual embedding modes force overlap to 0.

5) **Resources require project context to be set.**
- `resources/list` uses the in‑memory request context; if `projects.resolve` was not called, resource listing will error with `project_id is required`.

## Next Steps: The “Resume Here” Checklist

1) Apply migrations and validate DB schema
- Files: `migrations/0013_outbox_retries.sql`
- Action: apply migrations to your dev DB.
- Validate:
  - `\d outbox_events` includes `retry_count` and `next_attempt_at`.

2) Run builds and tests
- Files: none
- Action:
  - `pnpm -r build`
  - run relevant tests (`pnpm --filter ... test`).
- Validate: all builds and tests pass.

3) Validate HNSW param propagation end‑to‑end
- Files: `packages/mcp-server/src/handlers.ts`, `packages/core/src/vector/indexManager.ts`
- Action:
  - Create an embedding profile with `provider_config.hnsw` values.
  - Trigger index creation.
- Validate:
  - `SELECT indexdef FROM pg_indexes WHERE indexname = ...` includes `WITH (m = ..., ef_construction = ...)`.

4) Validate dynamic `hnsw.ef_search` path
- Files: `packages/core/src/search/semantic.ts`
- Action:
  - Call `memory.search` (or direct `semanticSearch`) with various `top_k`.
- Validate:
  - No SQL errors.
  - `SET LOCAL` does not leak across pooled sessions.

5) Validate contextual embeddings for canonical docs
- Files: `packages/worker/src/jobs/embedVersion.ts`, `packages/clients/src/voyage.ts`, `packages/clients/src/jina.ts`
- Action:
  - Create a canonical doc with `doc_class` in `{app_spec, feature_spec, implementation_plan}`.
  - Ensure embedding profile supports contextual embedding.
  - Trigger embedding job.
- Validate:
  - embeddings inserted for all chunks.
  - retrieval quality is subjectively improved on “lost context” queries.

6) Validate MCP resources
- Files: `packages/mcp-server/src/resources.ts`
- Action:
  - Start MCP server and use an MCP client that supports resources.
  - Call `resources/list` and `resources/read`.
- Validate:
  - resources are returned and content is readable.

### Definition of done (immediate milestone)
- Migrations applied, worker runs without schema errors, MCP server compiles and starts, and the major delta features are exercised at least once in a local dev environment (HNSW tuning, dynamic ef_search, fusion boosts, contextual embeddings, resources list/read, outbox backoff).

## Appendix

### A. Example embedding profile configs
**Voyage contextual profile**
```json
{
  "base_url": "https://api.voyageai.com",
  "api_key": "${VOYAGE_API_KEY}",
  "hnsw": { "m": 16, "ef_construction": 64 },
  "query": { "ef_search_min": 40, "ef_search_factor": 2, "ef_search_max": 400 }
}
```

**Jina profile with late chunking enabled**
```json
{
  "base_url": "https://api.jina.ai",
  "api_key": "${JINA_API_KEY}",
  "late_chunking": true,
  "hnsw": { "m": 12, "ef_construction": 48 },
  "query": { "ef_search_min": 40, "ef_search_factor": 2, "ef_search_max": 400 }
}
```

### B. Outbox backoff behavior
- On failure: `retry_count += 1`, `next_attempt_at = now() + min(base * 2^(retry_count-1), maxDelay)`.
- On max retries: event is dead‑lettered by setting `processed_at` and `error`.

### C. Suggested Neo4j schema/index recipes
```cypher
// Recommended unique project root per environment
CREATE CONSTRAINT project_id_unique IF NOT EXISTS
FOR (p:Project)
REQUIRE (p.project_id, p.environment) IS UNIQUE;

// Fast lookups by project_id for common entity labels
CREATE INDEX decision_project IF NOT EXISTS FOR (d:Decision) ON (d.project_id);
CREATE INDEX plan_project IF NOT EXISTS FOR (p:Plan) ON (p.project_id);
CREATE INDEX task_project IF NOT EXISTS FOR (t:Task) ON (t.project_id);
```

### D. Suggested Qdrant metadata template
```json
{
  "project_id": "<current_project_id>",
  "environment": "dev",
  "memory_type": "summary",
  "scope": "session",
  "source_client": "openai-codex",
  "author_model": "gpt-5.2",
  "created_at": "2025-12-24T00:00:00Z",
  "tags": ["memento", "post-mvp", "delta-plan"]
}
```


### E. Detailed migration catalog (what exists and why)
This section is intentionally verbose so a new session can reason about data model invariants without re-reading every migration.

**Migration ordering matters.** The repository expects migrations to be applied in filename order.

- `migrations/0001_extensions.sql`
  - Installs required Postgres extensions (typically `pgcrypto`, `vector`, `pg_trgm`, etc.; exact content depends on the file).
  - Why it matters: chunk trigram index uses `pg_trgm`, vector storage uses `pgvector`.

- `migrations/0002_tenancy.sql`
  - Creates tenancy primitives:
    - `workspaces(id, name, created_at)`
    - `projects(id, workspace_id, project_key, display_name, repo_url, status, created_at)`
  - Adds `UNIQUE(workspace_id, project_key)` and index `projects_workspace_idx`.

- `migrations/0003_sessions_commits.sql`
  - Creates audit primitives:
    - `sessions(id, project_id, client_name, started_at, ended_at, metadata)`
    - `commits(id, project_id, session_id, idempotency_key, author, summary, created_at)`
  - Adds uniqueness `UNIQUE(project_id, idempotency_key)` for idempotent writes.

- `migrations/0004_memory_items_versions.sql`
  - Creates enum types:
    - `memory_scope`: `project | workspace_shared | global`
    - `memory_kind`: `spec | plan | architecture | decision | troubleshooting | runbook | environment_fact | session_snapshot | note | snippet`
  - Creates versioned memory primitives:
    - `memory_items` (identity + metadata + canonical key + doc class)
    - `memory_versions` (immutable content versions with `version_num` per `item_id`)
  - Critical constraints:
    - `UNIQUE(project_id, canonical_key)` on `memory_items` (canonical key is stable within project)
    - `UNIQUE(item_id, version_num)` on `memory_versions`

- `migrations/0005_canonical_docs.sql`
  - Creates canonical registry `canonical_docs(project_id, item_id, canonical_key, doc_class, status, created_at)`
  - Constraints:
    - `UNIQUE(project_id, canonical_key)` ensures one canonical doc per key per project.
    - `UNIQUE(item_id)` ensures an item is at most one canonical doc.

- `migrations/0006_chunking.sql`
  - Creates chunk storage `memory_chunks` with:
    - `heading_path[]` and `section_anchor` for structure-preserving retrieval.
    - `start_char`, `end_char` for slicing the original `content_text`.
    - `tsv` for lexical retrieval.
  - Creates indexes:
    - `GIN(tsv)` for full text search.
    - `GIN(chunk_text gin_trgm_ops)` for trigram similarity.

- `migrations/0007_embeddings.sql`
  - Creates `embedding_profiles` with JSON `provider_config`.
  - Creates `chunk_embeddings` with dimensionless `VECTOR` column.
  - Documents the “expression index per dims/profile” pattern required by pgvector.

- `migrations/0008_links_outbox_sources.sql`
  - Creates:
    - `memory_links` for typed relationships between items.
    - `outbox_events` for async worker processing.
    - `ingest_sources` for automated ingestion sources.

- `migrations/0009_triggers.sql`
  - Adds important database-level invariants:
    - `updated_at` auto-maintenance on `memory_items`.
    - `project_id` propagation triggers:
      - `memory_versions.project_id` derived from `memory_items.project_id`.
      - `memory_chunks.project_id` derived from `memory_versions.project_id`.
      - `chunk_embeddings.project_id` derived from the chunk’s project_id.
    - Cross-table consistency validations:
      - chunk/project mismatch between `memory_chunks` and `embedding_profiles` is rejected.
      - canonical doc mismatch between `canonical_docs` and `memory_items` is rejected.

- `migrations/0010_outbox_leases.sql`
  - Adds processing lease fields on `outbox_events`:
    - `processing_started_at`, `processing_expires_at`, and `attempts`.

- `migrations/0011_embedding_profiles_active_unique.sql`
  - Enforces a single active embedding profile per project (implementation-specific; see file for exact constraint/index).

- `migrations/0012_indexes_doc_class_tags.sql`
  - Adds indexes that speed doc_class/tag filtering.

- `migrations/0013_outbox_retries.sql` (added this session)
  - Adds retry/backoff fields on `outbox_events`:
    - `retry_count`, `next_attempt_at`, `locked_at`, `locked_by`
  - Adds index on `next_attempt_at` for efficient polling.

- `migrations/0090_optional_bm25_pg_search.sql` (modified this session)
  - Optional. Creates `pg_search` extension and a `bm25` index `idx_chunks_bm25`.
  - WARNING: not safe on all Postgres distributions.

### F. Tables and invariants (practical schema notes)

#### `embedding_profiles`
Columns:
- `id`, `project_id`
- `name`, `provider`, `model`, `dims`, `distance`
- `is_active`
- `provider_config` (JSONB)

How it is used:
- The **active** profile is used by semantic search and by the worker when embedding versions (unless overridden).
- `provider_config` now contains:
  - `hnsw`: index creation params
  - `query`: ef_search tuning
  - `late_chunking`: enable contextual mode for Jina

#### `chunk_embeddings`
Columns:
- `chunk_id`, `embedding_profile_id` (unique per pair)
- `embedding` (dimensionless VECTOR)

How it is indexed:
- Per profile: partial expression HNSW index created by `ensureProfileIndex(...)`:
  - `USING hnsw ((embedding::vector(dims)) <opclass>) WHERE embedding_profile_id = '<profileId>'`

#### `outbox_events`
Base columns from `0008`:
- `id`, `project_id`, `event_type`, `payload`, `created_at`, `processed_at`, `error`
Lease columns from `0010`:
- `processing_started_at`, `processing_expires_at`, `attempts`
Retry columns from `0013`:
- `retry_count`, `next_attempt_at`, `locked_at`, `locked_by`

How worker uses them now:
- Poll query filters to `processed_at IS NULL` and:
  - lease expired or never leased
  - `next_attempt_at` is NULL or due
  - `retry_count < OUTBOX_MAX_ATTEMPTS`

### G. MCP tool surface (stable names)
Tool name registry lives in `packages/shared/src/tool-names.ts` and should remain stable.

Projects and sessions:
- `projects.resolve`, `projects.list`
- `sessions.start`, `sessions.end`

Embedding profile tools:
- `embedding_profiles.list`, `embedding_profiles.upsert`, `embedding_profiles.activate`

Memory CRUD/search:
- `memory.commit`, `memory.get`, `memory.search`, `memory.restore`
- `memory.history`, `memory.diff`
- `memory.pin`, `memory.unpin`, `memory.archive`, `memory.link`

Canonical docs:
- `canonical.upsert`, `canonical.get`, `canonical.outline`, `canonical.get_section`, `canonical.context_pack`

Admin/health:
- `admin.reindex_profile`, `admin.reingest_version`, `health.check`

### H. MCP resources (how to use)
MCP resources are separate from tools; they are read-only and designed for browsing.

Resource templates registered in `packages/mcp-server/src/resources.ts`:
- `memory-item` template: `memory://projects/{project_id}/items/{item_id}`
  - List callback returns up to 50 recent active items (pinned first).
  - Read callback returns latest `memory_versions.content_text`.
- `memory-item-version` template: `memory://projects/{project_id}/items/{item_id}/versions/{version_num}`
  - Read callback returns the specific version’s `content_text`.
- `memory-item-section` template: `memory://projects/{project_id}/items/{item_id}/sections/{section_anchor}`
  - Read callback slices canonical sections based on `memory_chunks.start_char/end_char` (falls back to concatenated chunks).

Operational note:
- Resource listing requires the MCP server’s in-memory request context to have an active project set (usually done by calling `projects.resolve` early in a session).

### I. Hybrid retrieval details (FTS + pg_trgm + pgvector + RRF)

#### Lexical lane (baseline)
- Implemented in `packages/core/src/search/lexical.ts`.
- Uses:
  - `websearch_to_tsquery('english', $1)` against `memory_chunks.tsv`.
  - Optional trigram match `mc.chunk_text % $1` when query “looks like code”.
  - Score: `ts_rank_cd(tsv, tsQuery) + trigram_weight * similarity(chunk_text, query)`.

#### Lexical lane (optional BM25)
- Enabled only if:
  - extension `pg_search` exists
  - index `idx_chunks_bm25` exists
- Uses:
  - match operator `chunk_text ||| query`
  - score function `pdb.score(mc.id)`
- Falls back to baseline lexical lane if detection fails or query errors.

#### Semantic lane
- Implemented in `packages/core/src/search/semantic.ts`.
- Key properties:
  - Uses the active embedding profile.
  - Sets `SET LOCAL hnsw.ef_search = $1` before the vector query in the same transaction.
  - Calculates ef_search by:
    - `ef_search = clamp(max(min, topK, topK*factor), min, max)` and ensures `>= topK`.

#### Fusion (RRF)
- Implemented in `packages/core/src/search/fusion.ts`.
- Default weights: lexical 0.4, semantic 0.5, trigram 0.1.
- Boosts:
  - canonical and pinned are implemented as additional ranked lists with weights (defaults 0.1 each).
  - This is different from a constant additive bump and is typically more stable.

#### Weight profiles
- Implemented in `packages/core/src/search/search.ts`.
- Query style inference heuristics:
  - Code-like queries (stack traces, identifiers, symbols) → profile `code`.
  - Longer natural-language queries → profile `conversational`.
  - Short normal queries → profile `technical`.

### J. Contextual embeddings behavior (canonical docs)

#### Where contextual mode is decided
- Worker job `packages/worker/src/jobs/embedVersion.ts` queries the version and joins `memory_items` and `canonical_docs`.
- It marks a version as canonical if:
  - `canonical_docs` row exists, OR
  - `memory_items.canonical_key` exists.
- It uses contextual embedding only for doc classes:
  - `app_spec`, `feature_spec`, `implementation_plan`.

#### Provider-specific controls
- Voyage: contextual method is present and always considered available if the embedder exposes `embedDocumentChunksContextual`.
  - You must configure the embedding profile’s `model` to a model supported by the contextual endpoint.
- Jina: contextual mode is gated by `provider_config.late_chunking`.
  - If `late_chunking` is false/missing, the worker will NOT use contextual mode for canonical docs.

#### Important chunking note
- The chunker (`packages/core/src/chunking/chunker.ts`) currently does not implement overlap; `overlapTokens` is part of the config but has no effect.
- If overlap is implemented later, ensure contextual modes force overlap to 0.

### K. Operational walkthrough (end-to-end local smoke test)
This is a suggested playbook for the next session to validate the implementation.

1) Start DB
```bash
cd /Users/brennanconley/vibecode/memento
docker compose up -d
```

2) Apply migrations
```bash
for f in migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

3) Build packages
```bash
pnpm -r build
```

4) Start worker
```bash
node packages/worker/dist/main.js
```

5) Start MCP server (stdio)
```bash
node packages/mcp-server/dist/main.js
```

6) Use an MCP client to:
- Call `projects.resolve` for the working repo.
- Call `sessions.start`.
- Upsert an embedding profile with provider_config containing `hnsw` and `query`.
- Commit a canonical doc and a non-canonical troubleshooting note.
- Wait for worker processing (or poll `outbox_events`).
- Run `memory.search` on:
  - natural language query
  - exact token/identifier query
  - query targeting canonical plan sections
- Verify that:
  - trigram improves identifier recall
  - canonical doc items appear strongly
  - semantic search returns results and does not error

### L. Qdrant and Neo4j: more explicit session-awareness details

#### Qdrant (semantic memory)
Qdrant stores “points” that consist of:
- `id` (string/uuid)
- vector embedding (float array)
- payload metadata (JSON)

Project separation rules (critical):
- Use **one collection per project**: `"<project_id>-mem"`.
- Every stored point must include `payload.project_id = <project_id>`.
- Filtering:
  - Always query only the current project’s collection.
  - If you must use a shared collection, then enforce a payload filter on `project_id`.

Suggested payload schema for memories:
- Required:
  - `project_id`, `environment`, `memory_type`, `source_client`, `author_model`, `created_at`
- Optional:
  - `updated_at`, `scope`, `tags`, `confidence`, `related_files`, `related_tasks`

Suggested Qdrant collection/index notes:
- If you store multiple embedding models/dims in Qdrant:
  - Prefer separate collections per embedding model or embedder profile.
  - Alternatively, store multiple named vectors per point if supported by your Qdrant setup.
- Use cosine distance if embeddings are normalized.

#### Neo4j (graph memory)
Neo4j stores nodes/relationships; this session assumes a project-scoped knowledge graph with stable conventions.

Recommended indexes and constraints (minimal viable):
- A unique constraint on `Project(project_id, environment)`.
- Indexes on `project_id` for frequently queried labels.
- Optional full-text index over `title` and `description`.

Recommended relationship vocabulary:
- `HAS_PLAN`, `HAS_DECISION`, `HAS_TASK`, `HAS_SUMMARY`
- `BLOCKED_BY`, `INFLUENCES`, `VALIDATES`, `REFERENCES`, `DEPENDS_ON`

Recommended “no cross-project mixing” enforcement:
- Either enforce at write time in the application logic (preferred),
- Or encode `project_id` in relationship properties and validate via a periodic check.

### M. Quick reference: where to tune what

**Vector index build quality (HNSW)**
- Tune via embedding profile `provider_config.hnsw`:
  - `m`: graph out-degree
  - `ef_construction`: build candidate list size

**Vector search recall/latency**
- Tune via embedding profile `provider_config.query`:
  - `ef_search_min`, `ef_search_factor`, `ef_search_max`

**Lexical vs semantic weighting**
- Tune in code in `packages/core/src/search/search.ts` (weight profiles).
- Tune RRF constants in `packages/core/src/search/fusion.ts`.

**Jina contextual mode**
- Set `provider_config.late_chunking = true`.

**BM25**
- Apply optional migration and ensure the extension exists.

### N. Additional verification queries (SQL)

Check HNSW index definition:
```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'chunk_embeddings_hnsw_%';
```

Check outbox backlog:
```sql
SELECT event_type, count(*)
FROM outbox_events
WHERE processed_at IS NULL
GROUP BY event_type
ORDER BY count(*) DESC;
```

Check retry scheduling:
```sql
SELECT id, event_type, retry_count, next_attempt_at, error
FROM outbox_events
WHERE processed_at IS NULL
ORDER BY created_at ASC
LIMIT 50;
```

Check BM25 availability:
```sql
SELECT 1 FROM pg_extension WHERE extname = 'pg_search';
SELECT 1 FROM pg_indexes WHERE indexname = 'idx_chunks_bm25';
```


### O. File-by-file implementation notes (so you can jump directly to code)

#### `packages/core/src/vector/indexManager.ts`
What changed:
- `ensureProfileIndex(...)` now accepts `options.hnsw` and adds a `WITH (...)` clause for pgvector HNSW indexes.
- The code re-checks existing `pg_indexes.indexdef` and drops/recreates the index if:
  - vector dims mismatch
  - opclass mismatch
  - predicate mismatch
  - (new) HNSW param mismatch for `m` and/or `ef_construction`

Where to look next:
- If you need stricter validation of HNSW params (e.g., handle different spacing or ordering), update `hasIndexParam(...)`.
- If you want to support more pgvector index knobs later, extend `HnswConfig` and `formatHnswParams(...)`.

#### `packages/core/src/search/semantic.ts`
What changed:
- `resolveEfSearch(profile, topK, override)` reads `provider_config.query` and computes a clamped ef_search.
- Uses `client.query("SET LOCAL hnsw.ef_search = $1", [efSearch])` inside `BEGIN`/`COMMIT`.

Operational notes:
- This is intentionally per-request and per-transaction, so pooled connections should not leak ef_search.
- If your workload has very large `top_k`, consider raising `ef_search_max` (but be mindful of latency).

#### `packages/core/src/search/search.ts`
What changed:
- Added internal weight profiles (`default`, `technical`, `conversational`, `code`).
- Added heuristic `inferQueryStyle(query)`.
- If the caller does not provide explicit `fusion.weights`, the code injects a profile-specific `weights`.

How to change behavior later:
- If you want configuration instead of heuristics, consider:
  - environment variables
  - project-level settings in the DB
  - making the MCP tool accept an optional `weight_profile` (this would be a schema change; avoid unless necessary).

#### `packages/core/src/search/fusion.ts`
What changed:
- Canonical and pinned boosts are now “ranked list channels” with weights.
- The defaults (`canonical_boost`, `pinned_boost`) are still 0.1, but they are no longer added as a flat `+0.1` score.

Expected effect:
- Boost is much more subtle and should not dominate lexical/semantic scores.
- If canonical docs do not surface strongly enough, increase the boost weight (carefully) or add a dedicated “canonical lane” in fusion.

#### `packages/core/src/search/lexical.ts`
What changed:
- Added optional BM25 lane detection:
  - checks `pg_extension` for `pg_search`
  - checks `pg_indexes` for `idx_chunks_bm25`
- If enabled, uses `chunk_text ||| $1::text` and `pdb.score(mc.id)`.

Important caveats:
- ParadeDB operator/function names can vary depending on version and configuration.
- The current code disables BM25 if the query throws and falls back to FTS.

#### `packages/clients/src/embedder.ts`
What changed:
- Added optional method `embedDocumentChunksContextual?(chunks)`.

Usage contract:
- Implementations should return one vector per chunk, in order.
- Dimensions must match the profile’s declared dims.

#### `packages/clients/src/voyage.ts`
What changed:
- Added `embedDocumentChunksContextual(chunks)` that calls `/v1/contextualizedembeddings`.

Critical configuration requirement:
- The profile’s model must be one that the contextual endpoint accepts (e.g., `voyage-context-3`).
- The worker will not validate model compatibility; it will surface the provider’s error.

#### `packages/clients/src/jina.ts`
What changed:
- Added `lateChunking` flag and `embedDocumentChunksContextual(chunks)`.
- Contextual method uses the same endpoint (`/v1/embeddings`) but sets `late_chunking`.

Configuration requirement:
- The worker only uses contextual embedding for Jina when `embedding_profiles.provider_config.late_chunking = true`.

#### `packages/worker/src/jobs/embedVersion.ts`
What changed:
- The job now queries `memory_versions` joined to `memory_items` and `canonical_docs`.
- If canonical + doc_class in `{app_spec, feature_spec, implementation_plan}` and embedder supports contextual method:
  - calls `embedder.embedDocumentChunksContextual([...chunks])`
  - inserts embeddings for all chunks in one pass
- Otherwise falls back to batched embedding with concurrency.

Performance note:
- Contextual embedding is called once for the whole doc; if canonical docs are very large, you may want to cap chunk count or split documents.

#### `packages/worker/src/outboxPoller.ts`
What changed:
- Poller now selects only ready events:
  - `next_attempt_at` due
  - `retry_count < OUTBOX_MAX_ATTEMPTS`
  - lease is free/expired
- On failure:
  - increments `retry_count`
  - sets `next_attempt_at` with exponential backoff
  - dead-letters by setting `processed_at` after max retries

Migration dependency:
- Requires `migrations/0013_outbox_retries.sql` applied.

#### `packages/mcp-server/src/resources.ts`
What changed:
- Implements resource templates with `ResourceTemplate` from MCP SDK.
- Provides list/read functionality keyed by the active project stored in request context.

Client UX implication:
- This enables “browse memory” flows in MCP clients that support resources.

### P. Example MCP tool calls (payload examples)
These examples are illustrative; exact shapes are enforced by Zod schemas in `packages/shared/src/schemas.ts`.

**Resolve project**
```json
{
  "tool": "projects.resolve",
  "input": {
    "workspace_name": "default",
    "cwd": "/Users/brennanconley/vibecode/memento",
    "repo_url": null,
    "create_if_missing": true,
    "display_name": "memento"
  }
}
```

**Upsert embedding profile with HNSW + ef_search tuning**
```json
{
  "tool": "embedding_profiles.upsert",
  "input": {
    "project_id": "<project_uuid>",
    "idempotency_key": "<uuid>",
    "name": "voyage-context",
    "provider": "voyage",
    "model": "voyage-context-3",
    "dims": 1024,
    "distance": "cosine",
    "provider_config": {
      "api_key": "${VOYAGE_API_KEY}",
      "hnsw": { "m": 16, "ef_construction": 64 },
      "query": { "ef_search_min": 40, "ef_search_factor": 2, "ef_search_max": 400 }
    },
    "set_active": true
  }
}
```

**Write canonical implementation plan**
```json
{
  "tool": "canonical.upsert",
  "input": {
    "project_id": "<project_uuid>",
    "idempotency_key": "<uuid>",
    "canonical_key": "implementation/plan",
    "doc_class": "implementation_plan",
    "title": "Implementation Plan",
    "content_markdown": "# Plan\n...",
    "tags": ["plan", "canonical"]
  }
}
```

**Hybrid search**
```json
{
  "tool": "memory.search",
  "input": {
    "project_id": "<project_uuid>",
    "query": "How does outbox retry backoff work?",
    "limit": 20,
    "include_chunks": true,
    "filters": { "canonical_only": false }
  }
}
```

### Q. Troubleshooting checklist for the delta features

1) Semantic search returns empty results unexpectedly
- Check active embedding profile exists for the project.
- Ensure worker has embedded chunks for the version/profile:
  - `SELECT count(*) FROM chunk_embeddings WHERE embedding_profile_id = '<profile_id>';`
- Ensure HNSW index exists:
  - `SELECT indexname FROM pg_indexes WHERE indexname LIKE 'chunk_embeddings_hnsw_%';`

2) Worker crashes with missing outbox columns
- Ensure `migrations/0013_outbox_retries.sql` was applied.

3) BM25 enabled but queries error
- Confirm extension/index:
  - `SELECT 1 FROM pg_extension WHERE extname='pg_search';`
  - `SELECT 1 FROM pg_indexes WHERE indexname='idx_chunks_bm25';`
- If operator/function names differ, update `packages/core/src/search/lexical.ts` BM25 SQL.
- If you cannot standardize the operator names, keep BM25 disabled (fallback is fine).

4) Contextual embeddings not being used
- Ensure the item is canonical:
  - `SELECT 1 FROM canonical_docs WHERE item_id='<item_id>';`
- Ensure doc_class is one of:
  - `app_spec`, `feature_spec`, `implementation_plan`
- For Jina:
  - ensure `embedding_profiles.provider_config.late_chunking = true`
- For Voyage:
  - ensure profile `model` matches contextual endpoint expectations.

5) MCP resources/list fails
- Ensure you called `projects.resolve` to set an active project in the MCP server context.
- Ensure the server is on an SDK version that supports resources (this repo pins `@modelcontextprotocol/sdk` ~1.25.x via pnpm).

