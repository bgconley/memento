# Context Restoration Document — Memento Post-MVP Second Pass Hardened

## Session Snapshot
This repo `/Users/brennanconley/vibecode/memento` is an MCP memory server scaffold with Postgres+pgvector storage, an outbox-driven worker (ingest/chunk/embed), and a STDIO MCP server that exposes tools and memory:// resources. The session focused on hardening the second-pass post-MVP implementation (lease-based outbox polling, two-stage semantic search, deterministic chunking with exact offsets, BM25 capability detection) and making it more beta-ready for single-user use. Several safety fixes were implemented (lease finalization guard, contextual embedding guard, BM25 ordering correction, Stage-B join parameter fix, chunker oversize splitting, reindex keyset pagination, and test-only index-build skipping). Worker and core tests now pass; mcp-server tests pass except `adminReindex.test.ts` which is still timing out. Migrations 0010/0013/0014 were applied manually via psql because the bulk migrate script is not idempotent against an existing DB. Full end-to-end integration with a real embedder is still pending; fake embedder tests run, but no real Voyage/Jina API run happened yet.

## Core Objectives and Non-Objectives
Objectives (success looks like):
- Lease-based outbox polling with short claim transactions, `lease_expires_at` and `locked_by` safeguards, and safe concurrent workers (<=3).
- Semantic search uses a two-stage ANN candidate query followed by a filtered join and is stable under filters and larger `top_k`.
- Chunker preserves exact `start_char/end_char` offsets, stores `chunk_text` as source slices, and avoids oversized chunks.
- BM25 is capability-detected, version-tolerant, and fail-open to FTS without dropping trigram-only hits.
- Worker/core tests pass locally; mcp-server tests pass after addressing the remaining `adminReindex` timeout.
- Voyage contextual embeddings are configured and exercised in a real integration smoke test.
Non-objectives (out of scope for this phase):
- Enterprise-grade observability, Prometheus metrics, or production multi-tenant hardening.
- Large-scale ranking regression suites or broad golden search fixtures.
- Schema-level changes to public MCP tool names or response formats.
- Removal of legacy outbox columns in existing migrations (defer to a later cleanup).
- Cross-project memory linking in Qdrant/Neo4j (only per-project isolation).

## Key Decisions and Rationale
Worker and outbox decisions:
- Decision: lease-based outbox claims with `FOR UPDATE SKIP LOCKED`, short transactions, and `lease_expires_at`; Rationale: avoid holding locks during network IO and allow multi-worker concurrency; Alternatives: long transactions around IO or relying on legacy `processing_expires_at` were rejected for lock risk and ambiguity.
- Decision: add `migrations/0014_outbox_lease_expiry.sql` instead of editing earlier migrations; Rationale: preserve migration order and avoid altering already-applied files; Alternatives: retrofitting 0010/0013 was rejected due to upgrade safety.
- Decision: `finalizeEventSuccess/Failure` checks `locked_by` before updating and poller supports `projectId` filtering; Rationale: avoid clobbering leases claimed by another worker and keep tests isolated; Alternatives: unconditional updates or ad-hoc test cleanup were rejected as unsafe.
- Decision: handlers run outside the claim transaction and accept a `Pool` instead of a `PoolClient`; Rationale: prevent long-running transactions across network calls and let each job manage its own write transaction; Alternatives: single transaction per job was rejected for lock risk.
- Decision: reindex uses keyset pagination over `(created_at,id)` with a cutoff; Rationale: avoid missing/duplicating rows under concurrent writes; Alternatives: offset pagination was rejected for instability.
- Decision: apply migrations 0010/0013/0014 manually via psql on existing DBs; Rationale: `scripts/migrate.sh` is not idempotent and fails when tables already exist; Alternatives: rebuilding the DB was rejected to preserve local data.
Search, chunking, and test decisions:
- Decision: semantic search is a two-stage ANN candidate query with oversampling (4x default, 8x with filters); Rationale: preserve HNSW index usage and recall under filters; Alternatives: single-query joins were rejected due to planner risk.
- Decision: Stage A uses `SET LOCAL hnsw.ef_search` with a literal and Stage B joins candidates via `unnest($1::uuid[], $2::double precision[])`; Rationale: pgvector SET does not accept bind params and `unnest` avoids huge VALUES lists; Alternatives: bind params or VALUES were rejected for runtime failures or plan cost.
- Decision: block-based chunker preserves absolute offsets and splits oversized blocks; Rationale: keep `chunk_text` as exact slices while bounding chunk size for large paragraphs/fences; Alternatives: concatenated reconstruction was rejected for offset drift.
- Decision: BM25 capability detection is fail-open and BM25 ordering uses combined BM25+trigram score; Rationale: tolerate operator/function variance and avoid dropping trigram-only hits; Alternatives: hard-fail or BM25-only ordering were rejected for portability.
- Decision: contextual embedding has guardrails (max chars/chunks) with fallback unless `CONTEXTUAL_STRICT=1`; Rationale: 40k-50k canonical docs can exceed provider limits; Alternatives: always fail or always contextual were rejected for reliability.
- Decision: mcp-server tests run sequentially and can skip index builds via `MEMENTO_SKIP_INDEX_BUILD`; Rationale: reduce test timeouts and flakiness; Alternatives: parallel execution with full index builds was rejected for instability.

## Current System Architecture
The system is a local MCP memory server with a Postgres storage layer, a worker that processes outbox events, and a STDIO MCP server that exposes tools and read-only resources. Writes (memory.commit or canonical.upsert) create memory versions and enqueue outbox events. The worker claims events via leases and runs ingest/embed jobs outside lock-holding transactions. Search is hybrid: lexical (FTS+trgm or BM25 if available) and semantic (pgvector ANN), fused via RRF. `memory://` resources slice the original markdown using chunk offsets and `section_anchor` metadata.

Key components:
- Postgres (pgvector, pg_trgm) with schema for workspaces/projects, memory items/versions, chunks, embeddings, and outbox events.
- Core library in `packages/core` providing chunking, vector index management, semantic/lexical/hybrid search, and outline/section slicing.
- Worker in `packages/worker` that polls the outbox and runs INGEST_VERSION, EMBED_VERSION, REINDEX_PROFILE with short transactions.
- MCP server in `packages/mcp-server` that implements tool handlers and resource resolvers; project context is set by `projects.resolve`.
- Clients in `packages/clients` for embedding providers (Voyage, Jina, OpenAI-compat) and a fake embedder for tests.

Mermaid (current behavior):
```mermaid
flowchart LR
  A[MCP Client] -->|tools: memory.commit / canonical.upsert| B[MCP Server (stdio)]
  B -->|SQL writes + enqueue outbox| C[(Postgres)]
  D[Worker] -->|claim leases (short tx)| C
  D -->|INGEST_VERSION + EMBED_VERSION| C
  D -->|embed API calls| E[Embedder Providers]
  A -->|memory.search| B
  B -->|lexical + semantic + RRF| C
  B -->|resource reads memory://| C
```

## Repository / Workspace Map
Important plan and context documents:
- `memento-enhanced-spec.md` is the base plan/spec for the project and remains the authoritative plan.
- `docs/context/claude-improvements-gpt-approved-firstpass-20252312.md` documents the first-pass improvements.
- `docs/context/claude-improvements-gpt-approved-plan-secondpass-20252312.md` documents the second-pass plan and intent.
- `docs/` contains reference docs and tool taxonomy; no structural changes in this session.

Core directories:
- `migrations/` contains ordered SQL migrations; `0014_outbox_lease_expiry.sql` adds `lease_expires_at` and index.
- `packages/core/` contains chunking, search, and vector index management.
- `packages/worker/` contains the outbox poller and jobs (ingest, embed, reindex).
- `packages/mcp-server/` contains MCP tool handlers, resources, and integration tests.
- `packages/clients/` provides embedder clients (Voyage, Jina, OpenAI-compat, Fake).
- `packages/shared/` provides shared tool names and types.

Modified core/worker files in this session:
- `packages/worker/src/outboxPoller.ts` adds `locked_by` guard, `projectId` filter support, and exports finalize functions.
- `packages/worker/src/jobs/embedVersion.ts` adds contextual guardrails and fallback behavior.
- `packages/worker/src/jobs/reindexProfile.ts` switches to keyset pagination with cutoff.
- `packages/core/src/search/semantic.ts` fixes Stage-B join to `unnest` arrays and `SET LOCAL` literal usage.
- `packages/core/src/search/bm25/lexicalBm25.ts` orders by combined BM25 and trigram score.
- `packages/core/src/chunking/chunker.ts` splits oversized blocks to bound chunk size.

Modified tests and mcp-server files in this session:
- `packages/core/test/chunking.test.ts` adds an oversized block split test.
- `packages/worker/test/outboxLease.test.ts`, `packages/worker/test/outboxPoller.test.ts`, `packages/worker/test/embedVersion.test.ts` updated for lease ownership and poller changes.
- `packages/mcp-server/src/handlers.ts` adds runtime `MEMENTO_SKIP_INDEX_BUILD` gate for test-only skipping of index builds.
- `packages/mcp-server/test/integrationFlow.test.ts` and `packages/mcp-server/test/adminReindex.test.ts` updated to use lease-based outbox polling.
- `packages/mcp-server/package.json` updates test command to sequential execution for stability.

Working tree note:
- The repo is known to be dirty with unrelated local modifications (docs, dist outputs, local env files).
- Do not delete or revert unrelated changes unless explicitly requested.
- When committing, scope to files listed above to avoid mixing unrelated changes.

## Implementation State (What Exists Right Now)
Implemented and verified:
- Lease-based outbox polling with short transactions and per-event finalization; supports multiple workers and clears leases on success/failure.
- Two-stage semantic search with candidate oversampling and filter-aware Stage-B join; `SET LOCAL hnsw.ef_search` is applied per query.
- Chunker now produces stable offsets and exact `chunk_text` slices; oversized blocks are split to avoid huge chunks.
- BM25 capability detection and fail-open fallback to FTS; BM25 ordering retains trigram-only matches.
- Migrations 0010/0013/0014 applied to local DB (`outbox_events` has `retry_count`, `next_attempt_at`, `locked_at`, `locked_by`, `lease_expires_at`).
- Tests: `pnpm --filter @memento/worker test` and `pnpm --filter @memento/core test` pass with `DATABASE_URL` set.

Partially implemented or not fully validated:
- `pnpm --filter @memento/mcp-server test` still times out on `packages/mcp-server/test/adminReindex.test.ts` after 20s.
- Full end-to-end runtime validation (worker + MCP server + real embedding provider) has not been run.
- BM25 tests are conditional and require `pg_search` + `idx_chunks_bm25` in the database.

Planned but not started (still on roadmap):
- Prometheus metrics endpoint and runtime observability improvements.
- Search quality regression suite with golden fixtures across lexical/semantic/fusion.
- Cleanup migration to deprecate legacy outbox columns (`processing_started_at`, `processing_expires_at`, `attempts`).

## Commands, Environments, and Runtime Assumptions
Assumptions:
- macOS with zsh, Node.js and pnpm workspace tooling.
- Postgres running via Docker Compose (`compose.yaml`) with pgvector and pg_trgm extensions.
- `DATABASE_URL` points to a local database with all migrations applied.

Install deps and build:
```bash
cd /Users/brennanconley/vibecode/memento
pnpm install
pnpm -r build
```

Start Postgres (Docker):
```bash
docker compose up -d
```

Apply migrations (manual, idempotent only per file):
```bash
for f in migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

Run worker and MCP server:
```bash
pnpm --filter @memento/worker build
node packages/worker/dist/main.js

pnpm --filter @memento/mcp-server build
node packages/mcp-server/dist/main.js
```

Tests:
```bash
DATABASE_URL=postgres://memento:memento@localhost:5432/memento \
  pnpm --filter @memento/core test

DATABASE_URL=postgres://memento:memento@localhost:5432/memento \
  pnpm --filter @memento/worker test

DATABASE_URL=postgres://memento:memento@localhost:5432/memento \
  MEMENTO_SKIP_INDEX_BUILD=1 \
  EMBEDDER_USE_FAKE=1 \
  pnpm --filter @memento/mcp-server test
```

Key environment variables (runtime):
- `DATABASE_URL` required for all DB access and tests.
- `WORKER_ID` optional override for worker identity (`hostname:pid` default).
- `OUTBOX_LEASE_SECONDS`, `OUTBOX_RETRY_DELAY_SECONDS`, `OUTBOX_RETRY_MAX_DELAY_SECONDS`, `OUTBOX_MAX_ATTEMPTS`.
- `EMBEDDER_USE_FAKE` set `true` for deterministic tests.
- `EMBEDDER_BASE_URL`, `EMBEDDER_API_KEY` for real provider calls.
- `CONTEXTUAL_MAX_CHARS` (default 50000), `CONTEXTUAL_MAX_CHUNKS` (default 256), `CONTEXTUAL_STRICT` (`1` to fail instead of fallback).
- `MEMENTO_SKIP_INDEX_BUILD` (`1` to skip HNSW index build in mcp-server handlers during tests).

Notes:
- `scripts/migrate.sh` is not safe on non-empty databases; prefer per-file psql.
- Run mcp-server tests sequentially due to shared DB state and outbox polling.

## Data, Models, and External Dependencies
Postgres schema (high-signal tables):
- `workspaces`, `projects`, `sessions`, `commits` for tenancy and audit trail.
- `memory_items`, `memory_versions` for versioned content and canonical keys.
- `canonical_docs` linking canonical keys to memory items and doc classes.
- `memory_chunks` with `chunk_text`, `heading_path`, `section_anchor`, `start_char`, `end_char`, and `tsv`.
- `chunk_embeddings` with `embedding_profile_id` and `embedding` vector.
- `embedding_profiles` for provider/model/dims/distance and `provider_config`.
- `outbox_events` with `retry_count`, `next_attempt_at`, `locked_at`, `locked_by`, `lease_expires_at`.

Embedding providers:
- Voyage (`packages/clients/src/voyage.ts`) supports `/v1/embeddings` and `/v1/contextualizedembeddings`.
- Jina (`packages/clients/src/jina.ts`) supports `/v1/embeddings` and `late_chunking` contextual mode.
- OpenAI-compat (`packages/clients/src/openaiCompat.ts`) uses OpenAI-compatible embeddings.
- Fake embedder for tests (no network IO).

Voyage contextual embedder (for canonical docs):
- Recommended model: `voyage-context-3`; dims are provider-defined (1024 or 2048 depending on model config).
- For large canonical docs (40k-50k chars), guardrails are enforced by `CONTEXTUAL_MAX_CHARS` and `CONTEXTUAL_MAX_CHUNKS`.
- API key should be supplied via `EMBEDDER_API_KEY` (preferred) or `provider_config.api_key` on the embedding profile.

Embedding profile example:
```json
{
  "name": "voyage-context",
  "provider": "voyage",
  "model": "voyage-context-3",
  "dims": 1024,
  "distance": "cosine",
  "provider_config": {
    "api_key": "${VOYAGE_API_KEY}",
    "hnsw": { "m": 16, "ef_construction": 64 },
    "query": { "ef_search_min": 40, "ef_search_factor": 2, "ef_search_max": 400 }
  }
}
```

Qdrant semantic memory (agent usage, not implemented in repo):
- Collection naming: one per project, `collection_name = "<project_id>-mem"`.
- Required metadata: `project_id`, `environment`, `memory_type`, `source_client`, `author_model`, `created_at`; optional `updated_at`, `scope`, `tags`.
- Store decisions, plans, summaries, tasks, bugs, constraints, and rules as concise summaries.
- Always read/write within the current project collection; no cross-project mixing unless explicitly requested.

Neo4j graph memory (agent usage, not implemented in repo):
- Project root node label: `Project` with `project_id`, `environment`, `source_client`, `author_model`, `created_at`, `updated_at`, `tags`.
- Entity labels: `Decision`, `Plan`, `Task`, `Bug`, `Experiment`, `Summary`, `Constraint`, `Rule`, `Session`.
- Required properties on every node: `project_id`, `environment`, `memory_type`, `source_client`, `author_model`, `created_at` (and `updated_at` when modified).
- Suggested constraints/indexes include: `CREATE CONSTRAINT project_id_unique IF NOT EXISTS FOR (p:Project) REQUIRE (p.project_id, p.environment) IS UNIQUE;` `CREATE INDEX decision_project IF NOT EXISTS FOR (d:Decision) ON (d.project_id);` `CREATE INDEX plan_project IF NOT EXISTS FOR (p:Plan) ON (p.project_id);` `CREATE INDEX task_project IF NOT EXISTS FOR (t:Task) ON (t.project_id);`
- Relationship vocabulary: `HAS_DECISION`, `HAS_PLAN`, `HAS_TASK`, `BLOCKED_BY`, `INFLUENCES`, `VALIDATES`, `SESSION_FOR_PROJECT`.

## Open Issues, Known Bugs, and Risks
- `packages/mcp-server/test/adminReindex.test.ts` still times out at 20s; suspected cause is drainOutbox loop or reindex job latency despite `MEMENTO_SKIP_INDEX_BUILD`; inspect test and `packages/worker/src/jobs/reindexProfile.ts`.
- Full integration run with real embeddings has not been executed; risk is provider limits or API config errors (Voyage/Jina) not covered by fake-embedder tests.
- `scripts/migrate.sh` is not idempotent and fails on existing DBs; risk is partial migration state if used on a non-empty database.
- Chunker uses line-based block parsing; complex markdown tables/lists may still produce unexpected block boundaries.
- Two-stage semantic Stage-B join now uses `unnest`, but very large `top_k` still increases array sizes and memory usage.
- BM25 is optional; environments lacking `pg_search` will always fall back to FTS, so BM25-specific tuning cannot be validated without the optional migration.
- Legacy outbox columns (`processing_started_at`, `processing_expires_at`, `attempts`) are unused and may confuse operators; no runtime risk but documentation risk.

## Next Steps: The "Resume Here" Checklist
1) Re-run mcp-server tests with env overrides and isolate the timeout; command: `DATABASE_URL=... MEMENTO_SKIP_INDEX_BUILD=1 EMBEDDER_USE_FAKE=1 pnpm --filter @memento/mcp-server test`; if `adminReindex.test.ts` still times out, inspect `packages/mcp-server/test/adminReindex.test.ts` and `packages/worker/src/jobs/reindexProfile.ts`, add targeted logs or reduce drainOutbox loop bounds; validation: test suite passes without timeouts.
2) Configure Voyage contextual embedder for real runs; set `EMBEDDER_API_KEY` (env) and use `embedding_profiles.upsert` with model `voyage-context-3`; validation: `embedding_profiles.list` shows active profile and `memory.search` returns semantic results with real vectors.
3) Run a full integration smoke test; start DB and apply migrations, start worker and MCP server, call `projects.resolve`, `sessions.start`, `canonical.upsert`, `memory.commit`, and `memory.search`; validation: outbox drains, embeddings written, and `memory://` resources read correctly.
4) If BM25 is desired, apply `migrations/0090_optional_bm25_pg_search.sql` in a compatible DB, then run `pnpm --filter @memento/core test -- lexicalBm25.test.ts`; validation: BM25 test passes and lexical fallback still works when BM25 is disabled.
5) Consider making migrations idempotent or documenting the safe path; if editing, update `scripts/migrate.sh` or add a new `scripts/migrate-existing-db.sh`; validation: running the script on a populated DB does not error.

Definition of done (next milestone):
- All three test suites pass (core, worker, mcp-server), and an integration smoke test with a real embedder succeeds end-to-end without outbox lease errors.

## Appendix
Outbox lease SQL (current semantics):
```sql
WITH candidate AS (
  SELECT id
  FROM outbox_events
  WHERE processed_at IS NULL
    AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
    AND retry_count < $MAX_RETRIES
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $BATCH_SIZE
)
UPDATE outbox_events e
SET locked_at = now(),
    locked_by = $WORKER_ID,
    lease_expires_at = now() + make_interval(secs => $LEASE_SECONDS)
FROM candidate
WHERE e.id = candidate.id
RETURNING e.*;
```

Finalize success:
```sql
UPDATE outbox_events
SET processed_at = now(),
    error = NULL,
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL,
    next_attempt_at = NULL
WHERE id = $EVENT_ID AND locked_by = $WORKER_ID;
```

Finalize failure (retry):
```sql
UPDATE outbox_events
SET error = $ERR,
    retry_count = retry_count + 1,
    next_attempt_at = $NEXT_ATTEMPT_AT,
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL
WHERE id = $EVENT_ID AND locked_by = $WORKER_ID;
```

Semantic search two-stage SQL (current):
```sql
BEGIN;
SET LOCAL hnsw.ef_search = 80;
SELECT
  ce.chunk_id,
  (ce.embedding::vector($DIMS) <=> $QUERY_VEC::vector($DIMS)) AS distance
FROM chunk_embeddings ce
WHERE ce.embedding_profile_id = $PROFILE_ID
ORDER BY ce.embedding::vector($DIMS) <=> $QUERY_VEC::vector($DIMS)
LIMIT $CANDIDATES;
COMMIT;
```

Stage B join (array-based):
```sql
SELECT mc.id AS chunk_id, mv.id AS version_id, mi.id AS item_id, t.distance
FROM unnest($1::uuid[], $2::double precision[]) AS t(chunk_id, distance)
JOIN memory_chunks mc ON mc.id = t.chunk_id
JOIN memory_versions mv ON mv.id = mc.version_id
JOIN memory_items mi ON mi.id = mv.item_id
WHERE mi.project_id = $PROJECT_ID AND mi.status = 'active'
ORDER BY t.distance ASC
LIMIT $TOP_K;
```

Chunker invariants:
- `chunk_text === markdown.slice(start_char, end_char)` is enforced by tests.
- Oversized blocks are split into bounded slices to avoid massive chunks.

Contextual embedding guardrails:
- Max chars per canonical doc default is 50000 (`CONTEXTUAL_MAX_CHARS`).
- Max chunks per canonical doc default is 256 (`CONTEXTUAL_MAX_CHUNKS`).
- If `CONTEXTUAL_STRICT=1`, contextual over-limit throws instead of fallback.

Example MCP tool payloads (manual validation):
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

Qdrant and Neo4j reminders:
- Qdrant collection: `<project_id>-mem`, always include `metadata.project_id`.
- Neo4j nodes must include `project_id` and match the active project; avoid cross-project relationships.

Diagnostic SQL snippets:
```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'chunk_embeddings_hnsw_%';
```

```sql
SELECT event_type, count(*)
FROM outbox_events
WHERE processed_at IS NULL
GROUP BY event_type
ORDER BY count(*) DESC;
```

```sql
SELECT id, locked_by, lease_expires_at, retry_count, next_attempt_at
FROM outbox_events
WHERE processed_at IS NULL
ORDER BY created_at ASC
LIMIT 50;
```

```sql
SELECT extversion FROM pg_extension WHERE extname = 'pg_search';
SELECT indexname FROM pg_indexes WHERE indexname = 'idx_chunks_bm25';
```

Verification items to confirm later:
- Verify `adminReindex` completes within 20s once drainOutbox and index build skipping are confirmed.
- Confirm Voyage contextual embedding endpoint limits for 50k char documents and adjust guardrails if needed.
- Confirm HNSW index parameters are applied per profile with `WITH (m=..., ef_construction=...)`.
