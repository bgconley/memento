# Context Restoration Document — Memento Post‑MVP Second Pass

## Session Snapshot
This repository (`/Users/brennanconley/vibecode/memento`) is an MCP “memory server” scaffold with Postgres+pgvector storage, an outbox-driven worker for ingest/chunk/embed, and an STDIO MCP server for tools/resources. In this session we implemented the **second‑pass post‑MVP integration plan** on top of the earlier “delta plan” work. The focus was: (1) lease‑based outbox polling with short claim transactions (no network IO inside claims), (2) semantic ANN query rewrite to a two‑stage candidate‑then‑join pattern, (3) a deterministic chunker refactor that preserves exact original text offsets, and (4) a robust, version‑sensitive BM25 capability layer with fail‑open fallback to FTS. The code builds (`pnpm -r build`), and chunking golden tests were regenerated, but full DB/runtime end‑to‑end validation (worker + MCP server + real embeddings) was not performed in this session. A new migration (`0014_outbox_lease_expiry.sql`) must be applied before the worker runs against the new lease-based poller.

## Core Objectives and Non-Objectives
**Objectives (success looks like):**
- Worker uses short claim transactions with `FOR UPDATE SKIP LOCKED`, leases via `lease_expires_at`, and releases leases on success/failure without holding DB locks across network IO.
- Semantic search uses a two‑stage pattern: HNSW candidate query on `chunk_embeddings`, then join/filter on `memory_chunks → memory_versions → memory_items` in a second query.
- Chunker computes `start_char/end_char` as absolute offsets into the original markdown and stores `chunk_text` exactly as `markdown.slice(start, end)`.
- BM25 is capability‑detected and version‑tolerant (supports `@@@`/`|||` and `paradedb.score`/`pdb.score`), with a fail‑open fallback to FTS.
- No breaking changes to tool schemas or public MCP tool names.

**Non‑Objectives (explicitly out of scope for this session):**
- Prometheus metrics endpoint or runtime observability upgrades.
- Ranking regression suites / golden fixtures beyond minimal new tests.
- End‑to‑end validation in a live DB with production embeddings.
- Any schema‑level changes to tool contracts or client‑visible APIs.
## Key Decisions and Rationale
1) **Lease‑based outbox polling with short claim transactions**
- **Decision:** Use `claimEvents()` with `FOR UPDATE SKIP LOCKED` and a lease (`lease_expires_at`), then process events outside the claim transaction. Finalize success/failure with single `UPDATE`s.
- **Rationale:** Avoid long‑running transactions and lock contention during network IO; safe concurrency across multiple workers.
- **Alternatives:** “BEGIN; claim; do network IO; COMMIT” and per‑row `processing_expires_at` leases. Rejected due to lock risk and request latency coupling.

2) **New `lease_expires_at` column via migration 0014**
- **Decision:** Add `lease_expires_at` in a new migration instead of modifying existing `0010`/`0013`.
- **Rationale:** Preserves migration order and avoids retroactive edits to applied migrations.
- **Alternatives:** Repurpose existing `processing_expires_at` columns. Rejected to avoid ambiguity and because current worker logic already moved away from those columns.

3) **Two‑stage semantic ANN query**
- **Decision:** Stage A: ANN candidate query on `chunk_embeddings` only (index‑friendly). Stage B: join to chunks/versions/items and apply filters on the candidate set.
- **Rationale:** HNSW planner is sensitive to joins/CTEs; pure ANN query encourages index use and stable recall under filtering.
- **Alternatives:** Single SQL query with joins and filters applied before ANN. Rejected due to planner risk and degraded index usage.

4) **Candidate oversampling: 4x default, 8x when filters present**
- **Decision:** `candidateLimit = top_k * 4` by default; `top_k * 8` when filters exist.
- **Rationale:** Filters can drop candidates; oversampling preserves recall.
- **Alternatives:** Fixed candidate count or no oversampling. Rejected due to recall loss with strong filters.

5) **Block‑based chunker with absolute offsets**
- **Decision:** Parse markdown into blocks with absolute `start/end` offsets; chunk offsets are block‑aligned and chunk text is always a slice of the original markdown.
- **Rationale:** Guarantees section extraction and resource slicing always map to the original text; simple, deterministic offsets.
- **Alternatives:** Reconstruct chunks by concatenating strings; offsets computed from reassembled lengths. Rejected due to drift and slicing mismatch.

6) **BM25 capability detection + fail‑open fallback**
- **Decision:** Add capability detection for `pg_search` extension, `bm25` index, operators (`@@@`/`|||`), and score function (`paradedb.score`/`pdb.score`). If BM25 errors, disable and fall back to FTS.
- **Rationale:** `pg_search` syntax varies by version/provider; fail‑open keeps search operational across environments.
- **Alternatives:** Assume one operator/function and hard‑fail. Rejected for portability and stability.
## Current System Architecture
**Components:**
- **Postgres DB** (Docker compose): stores workspaces/projects/sessions/commits, memory items/versions, canonical docs, chunks, embeddings, and outbox events.
- **Core library** (`packages/core`): DB access, chunking, vector index management, semantic/lexical/hybrid search.
- **Clients library** (`packages/clients`): embedder implementations (Voyage, Jina, OpenAI‑compat, Fake).
- **Worker** (`packages/worker`): polls outbox, performs ingest and embed jobs, handles retry/backoff.
- **MCP server** (`packages/mcp-server`): STDIO MCP server with tool handlers; also registers MCP resources for list/read.

**Data flow (high‑level):**
1. MCP tools write memory items/versions or canonical docs; outbox events are enqueued.
2. Worker claims outbox events quickly (short transaction), then performs IO and writes outside locks.
3. `INGEST_VERSION`: normalize markdown, chunk, insert `memory_chunks` with `tsv` and offsets.
4. `EMBED_VERSION`: fetch chunks + profile, call embedder, write to `chunk_embeddings`.
5. Search: lexical lane (FTS+trgm, optional BM25), semantic lane (pgvector with dynamic `SET LOCAL hnsw.ef_search`), fusion via RRF.
6. MCP resources allow read‑only browsing of memory via `memory://` URIs (latest item, version, section slices).

**Mermaid diagram (current behavior):**
```mermaid
flowchart LR
  A[MCP Client] -->|tools: memory.commit / canonical.upsert| B[MCP Server (stdio)]
  B -->|SQL writes| C[(Postgres)]
  B -->|enqueue outbox| C

  D[Worker] -->|claim (short tx)| C
  D -->|INGEST_VERSION| C
  D -->|EMBED_VERSION| E[Embedder Providers]
  E -->|Voyage/Jina/OpenAI-compat| D
  D -->|store embeddings| C

  A -->|tools: memory.search| B
  B -->|lexical search (FTS/optional BM25)| C
  B -->|semantic search (SET LOCAL ef_search)| C
  B -->|RRF fusion| B
  B -->|results + resource URIs| A

  A -->|resources/list| B
  A -->|resources/read (memory://...)| B
  B -->|read versions/chunks| C
```
## Repository / Workspace Map
**Root highlights:**
- `memento-enhanced-spec.md` — **base plan file** for the project; treat as the authoritative “plan” document.
- `migrations/` — ordered SQL migrations; new `0014_outbox_lease_expiry.sql` added this session.
- `packages/core/` — chunking, search, vector index management; multiple changes this session.
- `packages/worker/` — outbox poller + job handlers; reworked for lease‑based polling.
- `packages/mcp-server/` — MCP tools + resources (unchanged this session, but keep in mind from first pass).
- `docs/` — project docs, tool taxonomy, testing notes (unchanged this session).

**Files modified/added in this session (second pass):**
- `migrations/0014_outbox_lease_expiry.sql` **(new)** — adds `lease_expires_at` and index for lease checks.
- `packages/worker/src/outboxPoller.ts` **(modified)** — lease‑based claim, short tx, process outside locks, finalize success/failure, workerId support.
- `packages/worker/src/jobs/ingestVersion.ts` **(modified)** — read → chunk → transactionally delete+insert chunks with offset‑accurate `chunk_text` slices.
- `packages/worker/src/jobs/embedVersion.ts` **(modified)** — read chunks/profile; embed outside tx; insert in a write transaction.
- `packages/worker/src/jobs/reindexProfile.ts` **(modified)** — reads outside tx; writes in per‑page transaction.
- `packages/worker/src/jobs/embedderUtils.ts` **(modified)** — Queryable type to accept `Pool` or `PoolClient`.
- `packages/core/src/search/semantic.ts` **(modified)** — two‑stage ANN candidate query + join/filter; candidate oversampling.
- `packages/core/src/chunking/blocks.ts` **(new)** — markdown block parser with absolute offsets.
- `packages/core/src/chunking/chunker.ts` **(rewritten)** — block‑based chunking with exact offsets and optional overlap.
- `packages/core/src/search/bm25/capabilities.ts` **(new)** — detect `pg_search` availability and syntax.
- `packages/core/src/search/bm25/lexicalBm25.ts` **(new)** — BM25 query path (capability‑aware).
- `packages/core/src/search/bm25/lexicalFts.ts` **(new)** — FTS/trigram baseline query path.
- `packages/core/src/search/lexical.ts` **(modified)** — dispatcher: BM25 if available, else FTS; fail‑open fallback.
- `packages/core/src/search/lexicalTypes.ts` **(new)** — shared LexicalSearchOptions type.
- `packages/core/src/search/index.ts` **(modified)** — re‑exports lexical types for compatibility.

**Tests updated/added:**
- `packages/worker/test/outboxLease.test.ts` **(new)** — lease exclusivity, retry scheduling, dead‑letter behavior.
- `packages/core/test/search/semantic.test.ts` **(modified)** — adds filter‑sensitive semantic test.
- `packages/core/test/chunking.test.ts` **(modified)** — adds slice‑offset invariant checks.
- `packages/core/test/search/lexicalBm25.test.ts` **(new)** — conditional BM25 test (no‑op if extension unavailable).
- `packages/core/test/golden/chunking/basic.json` **(regenerated)**.
- `packages/core/test/golden/chunking/code-fence.json` **(regenerated)**.
## Implementation State (What Exists Right Now)
**Implemented and building:**
- Lease‑based outbox polling with `claimEvents()` and per‑event success/failure finalization; default workerId is `hostname:pid` (override with `WORKER_ID`).
- Short claim transaction, IO outside DB locks; backoff on failures with deterministic exponential delay.
- New lease column `lease_expires_at` and supporting index (migration 0014).
- Semantic search rewritten to two‑stage ANN candidate retrieval + filtered join; `SET LOCAL hnsw.ef_search` applies inside the Stage A transaction.
- Chunker refactor with absolute offsets via block parsing; chunk text stored as exact slices.
- Optional BM25 capability detection with `@@@` or `|||` operator and `paradedb.score` or `pdb.score` function, plus fail‑open fallback to FTS.

**Evidence / commands executed:**
- `UPDATE_GOLDENS=1 pnpm --filter @memento/core test -- chunking.test.ts` (regenerated chunking goldens).
- `pnpm -r build` (all packages compile).

**Partially implemented / not validated end‑to‑end:**
- No full DB runtime smoke test of worker + MCP server + embeddings in this session.
- Outbox tests (`packages/worker/test/*.test.ts`) and semantic tests were not run; they require `DATABASE_URL` and applied migrations.
- BM25 tests are conditional; must be run in an environment where `pg_search` + `bm25` index exist.

**Planned but not started (still from first pass / roadmap):**
- Prometheus metrics endpoint.
- Full ranking regression suite / golden search tests.

**Potential cleanup candidates (optional follow‑ups):**
- `processing_started_at`, `processing_expires_at`, and `attempts` columns (from migration 0010) are no longer used by the worker; consider deprecating or removing in a future cleanup migration.
## Commands, Environments, and Runtime Assumptions
**Environment assumptions:**
- macOS (zsh), Node + pnpm workspace.
- Postgres available via Docker compose (`compose.yaml`), with `pgvector` installed.

**Install dependencies:**
```bash
cd /Users/brennanconley/vibecode/memento
pnpm install
```

**Build:**
```bash
pnpm -r build
```

**Run Postgres (Docker compose):**
```bash
docker compose up -d
```

**Apply migrations (local dev):**
```bash
for f in migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```
Important: Ensure `migrations/0014_outbox_lease_expiry.sql` is applied before running the worker.

**Run worker:**
```bash
pnpm --filter @memento/worker build
node packages/worker/dist/main.js
```

**Run MCP server:**
```bash
pnpm --filter @memento/mcp-server build
node packages/mcp-server/dist/main.js
```

**Tests:**
```bash
pnpm --filter @memento/core test
pnpm --filter @memento/worker test
pnpm --filter @memento/mcp-server test
```

**Chunking golden update (only when intended):**
```bash
UPDATE_GOLDENS=1 pnpm --filter @memento/core test -- chunking.test.ts
```

**Key environment variables:**
- `DATABASE_URL` — Postgres connection string (required for tests and runtime).
- `WORKER_ID` — optional override for worker identifier (default `hostname:pid`).
- `OUTBOX_LEASE_SECONDS` — lease duration (default 120).
- `OUTBOX_RETRY_DELAY_SECONDS` — base retry delay (default 5).
- `OUTBOX_RETRY_MAX_DELAY_SECONDS` — max retry delay cap (default 600).
- `OUTBOX_MAX_ATTEMPTS` — dead‑letter threshold (default 5).
- `EMBEDDER_USE_FAKE` — `true` for deterministic tests.
- `EMBEDDER_BASE_URL`, `EMBEDDER_API_KEY` — embedder configuration.
## Data, Models, and External Dependencies
**Postgres schema (high‑signal tables):**
- `workspaces`, `projects`, `sessions`, `commits` — tenancy + audit.
- `memory_items`, `memory_versions` — versioned memory entries.
- `canonical_docs` — canonical doc registry (links to items).
- `memory_chunks` — chunk text + `heading_path`, `section_anchor`, `start_char/end_char`, `tsv` for lexical search.
- `chunk_embeddings` — vectors tied to `embedding_profile_id` and `chunk_id`.
- `embedding_profiles` — provider/model/dims/distance + `provider_config` JSON.
- `outbox_events` — async job queue for worker.

**Embedding providers / models:**
- Voyage (`packages/clients/src/voyage.ts`): `/v1/embeddings`, `/v1/contextualizedembeddings`.
- Jina (`packages/clients/src/jina.ts`): `/v1/embeddings`, optional `late_chunking`.
- OpenAI‑compat (`packages/clients/src/openaiCompat.ts`).
- Fake embedder for deterministic tests.

**Embedding profile `provider_config` (recommended shape):**
```json
{
  "hnsw": { "m": 16, "ef_construction": 64 },
  "query": { "ef_search_min": 40, "ef_search_factor": 2, "ef_search_max": 400 },
  "late_chunking": true,
  "base_url": "https://api.jina.ai",
  "api_key": "..."
}
```
**Optional BM25 (`pg_search` / ParadeDB):**
- Extension: `pg_search` (not universally available).
- Index: `idx_chunks_bm25` on `memory_chunks` (migration `0090_optional_bm25_pg_search.sql`).
- Operator/function variants detected at runtime: `@@@` or `|||`, and `paradedb.score` or `pdb.score`.
- If BM25 fails at runtime, search falls back to FTS + trigram.

**Qdrant semantic memory (agent awareness, not implemented in repo):**
- Server: `qdrant_memory` (MCP), one collection per project: `<project_id>-mem`.
- Required metadata keys per item: `project_id`, `environment`, `memory_type`, `source_client`, `author_model`, `created_at`; optional `updated_at`, `scope`, `tags`.
- Rules: never read/write across `project_id` boundaries unless explicitly requested.

**Neo4j graph memory (agent awareness, not implemented in repo):**
- Server: `neo4j_memory` (MCP), project‑scoped graph with `Project` root node.
- Recommended node labels: `Project`, `Decision`, `Plan`, `Task`, `Bug`, `Experiment`, `Summary`, `Constraint`, `Rule`, `Session`.
- Required node properties: `project_id`, `environment`, `memory_type`, `source_client`, `author_model`, `created_at`.
- Suggested constraints/indexes:
  - `Project(project_id, environment)` unique constraint.
  - Index on `project_id` for commonly queried labels.
- Relationship vocabulary: `HAS_PLAN`, `HAS_DECISION`, `HAS_TASK`, `BLOCKED_BY`, `INFLUENCES`, `VALIDATES`, `SESSION_FOR_PROJECT`.
## Open Issues, Known Bugs, and Risks
1. **Migration required for lease column**
   - **Symptom:** Worker `claimEvents()` errors on missing `lease_expires_at`.
   - **Cause:** New migration `0014_outbox_lease_expiry.sql` not applied.
   - **Where to look:** `packages/worker/src/outboxPoller.ts`, migration file.

2. **Legacy outbox columns still exist and are unused**
   - **Symptom:** Confusion about `processing_expires_at` vs `lease_expires_at`.
   - **Cause:** Older migration `0010_outbox_leases.sql` added `processing_*` columns that are no longer referenced in code.
   - **Risk:** Operator confusion; no runtime risk if unused.

3. **Semantic Stage‑B `VALUES` size could grow**
   - **Symptom:** Very large candidate sets can create big SQL parameter lists.
   - **Cause:** Candidate oversampling multiplies `top_k` (4x or 8x).
   - **Risk:** Parameter limit or query planning overhead on huge `top_k`.

4. **Chunker table/list heuristics**
   - **Symptom:** Some markdown edge cases might be misclassified as table/list blocks.
   - **Cause:** Lightweight line‑based parser in `blocks.ts` (no full markdown AST).
   - **Risk:** Chunk boundaries may differ from expectations on complex markdown.

5. **BM25 syntax/version variance**
   - **Symptom:** `pg_search` operator or score function not found.
   - **Cause:** Environment uses a different schema/operator signature.
   - **Mitigation:** Capability detection + fail‑open fallback to FTS; no hard failure.

6. **Test suite dependency on DB**
   - **Symptom:** Worker and search tests fail if migrations not applied or DB not running.
   - **Cause:** Tests require `DATABASE_URL` with all migrations applied.
## Next Steps: The “Resume Here” Checklist
1. **Apply DB migrations**
   - Files: `migrations/0014_outbox_lease_expiry.sql` (and ensure `0013_outbox_retries.sql` already applied).
   - Action: `for f in migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done`
   - Validate: `\d outbox_events` shows `lease_expires_at`, `retry_count`, `next_attempt_at`, `locked_at`, `locked_by`.

2. **Run worker tests for leasing + retries**
   - Files: `packages/worker/test/outboxLease.test.ts`, `packages/worker/src/outboxPoller.ts`.
   - Action: `pnpm --filter @memento/worker test`
   - Validate: outbox tests pass; no deadlocks or missing columns.

3. **Run core search tests**
   - Files: `packages/core/src/search/semantic.ts`, `packages/core/test/search/semantic.test.ts`.
   - Action: `pnpm --filter @memento/core test`
   - Validate: semantic tests pass; filter‑aware test returns correct item.

4. **Optional: validate BM25 path**
   - Files: `packages/core/src/search/bm25/*`, `packages/core/test/search/lexicalBm25.test.ts`.
   - Action: Apply `migrations/0090_optional_bm25_pg_search.sql` in an environment that supports `pg_search`, then run tests.
   - Validate: BM25 test passes; lexical search falls back to FTS if BM25 not available.

5. **Smoke test worker + MCP server**
   - Files: `packages/worker/src/*`, `packages/mcp-server/src/*`.
   - Action: Start DB, apply migrations, run worker and MCP server; execute tool calls to commit content, wait for ingest/embed, run `memory.search`.
   - Validate: results return without errors; no lock contention; outbox events are processed and marked done.

**Definition of done (next milestone):**
- Migrations applied, worker tests + core tests pass, and local smoke test confirms lease‑based outbox and two‑stage semantic search operate without runtime errors.
## Appendix
### A) Outbox lease + retry SQL (current worker semantics)
**State model (single table):**
- **Ready:** `processed_at IS NULL` AND `(next_attempt_at IS NULL OR next_attempt_at <= now())` AND `(lease_expires_at IS NULL OR lease_expires_at < now())`.
- **Leased:** `lease_expires_at > now()` AND `locked_by` is set.
- **Done:** `processed_at IS NOT NULL`.
- **Dead‑letter:** `retry_count >= OUTBOX_MAX_ATTEMPTS` (still stored, but excluded from claim).

**Claim query (short transaction):**
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
**Finalize success:**
```sql
UPDATE outbox_events
SET processed_at = now(),
    error = NULL,
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL,
    next_attempt_at = NULL
WHERE id = $EVENT_ID;
```

**Finalize failure (retry):**
```sql
UPDATE outbox_events
SET error = $ERR,
    retry_count = retry_count + 1,
    next_attempt_at = $NEXT_ATTEMPT_AT,
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL
WHERE id = $EVENT_ID;
```

**Finalize failure (dead‑letter):**
```sql
UPDATE outbox_events
SET processed_at = now(),
    error = $ERR,
    retry_count = retry_count + 1,
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL,
    next_attempt_at = NULL
WHERE id = $EVENT_ID;
```

**Backoff formula:**
- `retry_delay * 2^(retry_count-1)` capped at `OUTBOX_RETRY_MAX_DELAY_SECONDS`.
- Deterministic (no jitter) by design for now.
### B) Semantic search two‑stage SQL (index‑friendly)
**Stage A (ANN candidates only, with `SET LOCAL hnsw.ef_search`):**
```sql
BEGIN;
SET LOCAL hnsw.ef_search = $EF_SEARCH;
SELECT
  ce.chunk_id,
  (ce.embedding::vector($DIMS) <=> $QUERY_VEC::vector($DIMS)) AS distance
FROM chunk_embeddings ce
WHERE ce.embedding_profile_id = $PROFILE_ID
ORDER BY ce.embedding::vector($DIMS) <=> $QUERY_VEC::vector($DIMS)
LIMIT $CANDIDATES;
COMMIT;
```

**Stage B (join + filter):**
```sql
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
  LEFT(mc.chunk_text, $MAX_CHARS) AS excerpt,
  t.distance AS distance
FROM (VALUES
  -- (chunk_id, distance) tuples
) AS t(chunk_id, distance)
JOIN memory_chunks mc ON mc.id = t.chunk_id
JOIN memory_versions mv ON mv.id = mc.version_id
JOIN memory_items mi ON mi.id = mv.item_id
WHERE mi.project_id = $PROJECT_ID
  AND mi.status = 'active'
  -- + filters from appendItemFilters
ORDER BY t.distance ASC
LIMIT $TOP_K;
```

**Candidate oversampling:**
- `candidateLimit = top_k * 4` (default).
- `candidateLimit = top_k * 8` when filters exist.
### C) Chunker refactor (blocks + absolute offsets)
**Block types:** `heading`, `paragraph`, `list`, `code_fence`, `table`, `blank`.

**Parsing rules (line‑based, deterministic, no AST):**
- Headings: `^#{1,6} `; update `heading_path` stack and emit `heading` block.
- Code fences: lines starting with ``` or ~~~; capture until matching fence.
- Tables: a line with `|` followed by a separator row (`|---|` pattern); capture contiguous table rows.
- Lists: lines that match `-`, `*`, `+`, or `1.`; capture subsequent indented or list lines.
- Paragraphs: consecutive non‑blank, non‑heading, non‑fence, non‑list, non‑table lines.
- Blank lines: preserved as `blank` blocks to maintain offsets.

**Chunk assembly:**
- Chunks are contiguous runs of blocks; boundaries when target token budget exceeded or heading path changes.
- `start_char = blocks[first].start`, `end_char = blocks[last].end`.
- `chunk_text = markdown.slice(start_char, end_char)`.

**Key invariant (tested):**
```
chunk_text === original_markdown.slice(start_char, end_char)
```

**Overlap (optional):**
- Overlap is block‑based; the tail blocks of a chunk are reused if `overlapTokens > 0`.
- Overlap is **disabled** for canonical doc classes during ingest to avoid contextual embedding coupling.
### D) BM25 capability detection + fail‑open fallback
**Detection logic (`packages/core/src/search/bm25/capabilities.ts`):**
- Extension installed: `SELECT extversion FROM pg_extension WHERE extname = 'pg_search'`.
- BM25 index exists: `pg_indexes` with `indexdef ILIKE '%USING bm25%'`.
- Operator detection: `pg_operator` for `@@@` or `|||`.
- Score function detection: `pg_proc` join `pg_namespace` for `paradedb.score` or `pdb.score`.
- Capabilities cached per process; `disableBm25()` sets cache to `null` after runtime failures.

**BM25 query shape (capability‑aware):**
```sql
SELECT mc.id, mv.id, mi.id, ...,
       paradedb.score(mc.id) AS lexical_score
FROM memory_chunks mc
JOIN memory_versions mv ON mv.id = mc.version_id
JOIN memory_items mi ON mi.id = mv.item_id
WHERE mc.chunk_text @@@ $QUERY::text
ORDER BY lexical_score DESC
LIMIT $TOP_K;
```
(Operator and score function swap based on detected capabilities.)

**Fallback behavior:**
- If BM25 throws (operator/function missing), the dispatcher disables BM25 and reruns FTS for the remainder of the process lifetime.
### E) Tests and fixtures (new/updated)
**Worker tests:**
- `packages/worker/test/outboxLease.test.ts`:
  - **Lease exclusivity**: two claims, only one worker gets the event.
  - **Retry scheduling**: failing handler increments `retry_count` and sets `next_attempt_at`.
  - **Dead‑letter**: once `retry_count >= OUTBOX_MAX_ATTEMPTS`, event is not claimed again.

**Core tests:**
- `packages/core/test/chunking.test.ts`:
  - Adds invariant check for `chunk_text` slice consistency.
  - Goldens updated via `UPDATE_GOLDENS=1`.
- `packages/core/test/search/semantic.test.ts`:
  - Adds filter‑aware semantic test; verifies Stage B filtering.
- `packages/core/test/search/lexicalBm25.test.ts`:
  - Conditional BM25 test; no‑ops if `pg_search` not available.

**Note:** All tests require `DATABASE_URL` with migrations applied.
### F) Diagnostic SQL snippets
**Check HNSW index definitions:**
```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'chunk_embeddings_hnsw_%';
```

**Check outbox backlog:**
```sql
SELECT event_type, count(*)
FROM outbox_events
WHERE processed_at IS NULL
GROUP BY event_type
ORDER BY count(*) DESC;
```

**Check retry scheduling:**
```sql
SELECT id, event_type, retry_count, next_attempt_at, error
FROM outbox_events
WHERE processed_at IS NULL
ORDER BY created_at ASC
LIMIT 50;
```

**Check lease state:**
```sql
SELECT id, locked_by, lease_expires_at
FROM outbox_events
WHERE processed_at IS NULL
ORDER BY created_at ASC
LIMIT 50;
```

**Check BM25 availability:**
```sql
SELECT extversion FROM pg_extension WHERE extname = 'pg_search';
SELECT indexname FROM pg_indexes WHERE indexname = 'idx_chunks_bm25';
```
### G) MCP tool surface and resource URIs (reference)
**Tools (stable names; see `packages/shared/src/tool-names.ts`):**
- Projects: `projects.resolve`, `projects.list`
- Sessions: `sessions.start`, `sessions.end`
- Embedding profiles: `embedding_profiles.list`, `embedding_profiles.upsert`, `embedding_profiles.activate`
- Memory CRUD/search: `memory.commit`, `memory.get`, `memory.search`, `memory.restore`, `memory.history`, `memory.diff`
- Memory actions: `memory.pin`, `memory.unpin`, `memory.archive`, `memory.link`
- Canonical docs: `canonical.upsert`, `canonical.get`, `canonical.outline`, `canonical.get_section`, `canonical.context_pack`
- Admin: `admin.reindex_profile`, `admin.reingest_version`
- Health: `health.check`

**Resource URIs (list/read; `packages/mcp-server/src/resources.ts`):**
- `memory://projects/{project_id}/items/{item_id}` — latest item text
- `memory://projects/{project_id}/items/{item_id}/versions/{version_num}` — specific version text
- `memory://projects/{project_id}/items/{item_id}/sections/{section_anchor}` — section slice

**Operational note:** `resources/list` relies on `projects.resolve` having set the project context in MCP server request state.
### H) File-by-file implementation notes (second pass)
**Worker / outbox:**
- `packages/worker/src/outboxPoller.ts`
  - `claimEvents()` now owns the **only** transaction in the polling loop; it updates `locked_at/locked_by/lease_expires_at` in one SQL statement and returns claimed rows.
  - Processing loop calls handlers with `Pool` (not `PoolClient`), allowing handlers to manage their own write transactions.
  - `finalizeEventSuccess()` clears lease fields and sets `processed_at`.
  - `finalizeEventFailure()` increments `retry_count`, schedules `next_attempt_at`, clears lease fields; dead‑letters when attempts exceed max.
  - Defaults: lease 120s; retry delay 5s; max delay 600s; max attempts 5.

- `packages/worker/src/jobs/ingestVersion.ts`
  - Reads `memory_versions` joined to `memory_items` + `canonical_docs` to determine canonical doc class.
  - Uses `chunkMarkdown(markdown, { overlapTokens: 0 })` for canonical doc classes.
  - Writes chunks in a transaction: `DELETE FROM memory_chunks WHERE version_id = $1` then `INSERT` batches.
  - Chunk text is always `markdown.slice(start_char, end_char)`.

- `packages/worker/src/jobs/embedVersion.ts`
  - Reads profile + chunks outside transactions; embedder IO runs outside DB locks.
  - Writes embeddings in a single transaction per job (contextual or batched).

- `packages/worker/src/jobs/reindexProfile.ts`
  - Paginates reads outside tx; writes in a per‑page transaction to avoid long locks.
**Core search and chunking:**
- `packages/core/src/search/semantic.ts`
  - Builds query vector via embedder, computes `ef_search` from profile `provider_config.query`.
  - Stage A candidate query uses `ce.embedding::vector(dims)` with `ORDER BY` to force index use.
  - Stage B joins candidates (via `VALUES`) to `memory_chunks`/`memory_versions`/`memory_items` and applies `appendItemFilters`.
  - Candidate oversampling multiplier defaults to 4x, 8x with filters.

- `packages/core/src/search/lexical.ts`
  - Now a dispatcher only; calls `lexicalBm25` when capabilities allow, else `lexicalFts`.
  - On BM25 errors, calls `disableBm25()` to fail‑open for remainder of process lifetime.

- `packages/core/src/search/bm25/capabilities.ts`
  - Runtime detection for operators (`@@@`, `|||`) and score functions (`paradedb.score`, `pdb.score`).
  - Caches capability results for the process; `disableBm25()` clears cache.

- `packages/core/src/chunking/blocks.ts`
  - Line‑based parser for blocks with absolute offsets; tracks heading stack.
  - Emits `blank` blocks to preserve offsets; code fences handled as atomic blocks.

- `packages/core/src/chunking/chunker.ts`
  - Builds chunks from blocks, preserves `start_char`/`end_char` from the source markdown.
  - Overlap is block‑based; stored chunks can overlap by design when enabled.
### I) Qdrant semantic memory conventions (agent usage)
**Collection naming:** one per project, `collection_name = "<project_id>-mem"`.

**Payload schema (minimum):**
```json
{
  "project_id": "<current_project_id>",
  "environment": "dev",
  "memory_type": "summary|decision|plan|task|bug|experiment|constraint|rule",
  "scope": "project|feature|session|task",
  "source_client": "openai-codex",
  "author_model": "gpt-5.2",
  "created_at": "2025-12-24T00:00:00Z",
  "updated_at": "2025-12-24T00:00:00Z",
  "tags": ["memento", "post-mvp"]
}
```

**Rules:**
- Always write and read using the current project’s collection.
- Always include `metadata.project_id = current_project_id`.
- Never mix memories across projects unless explicitly asked to compare.

**Use cases:**
- Store decisions, plans, session summaries, bugs, experiments, constraints.
- Retrieve via semantic queries like “what did we decide about outbox retries?”
### J) Neo4j graph memory conventions (agent usage)
**Project root node:**
- Label: `Project`
- Properties: `project_id`, `environment`, `created_at`, `updated_at`, `source_client`, `author_model`, `tags`.

**Entity labels (examples):** `Decision`, `Plan`, `Task`, `Bug`, `Experiment`, `Summary`, `Constraint`, `Rule`, `Session`.

**Required properties on every node:**
- `project_id` (must match current project), `environment`, `memory_type`, `source_client`, `author_model`, `created_at` (and `updated_at` if modified).

**Recommended indexes/constraints:**
```cypher
CREATE CONSTRAINT project_id_unique IF NOT EXISTS
FOR (p:Project)
REQUIRE (p.project_id, p.environment) IS UNIQUE;

CREATE INDEX decision_project IF NOT EXISTS FOR (d:Decision) ON (d.project_id);
CREATE INDEX plan_project IF NOT EXISTS FOR (p:Plan) ON (p.project_id);
CREATE INDEX task_project IF NOT EXISTS FOR (t:Task) ON (t.project_id);
```

**Relationship patterns:**
- `(:Project)-[:HAS_DECISION]->(:Decision)`
- `(:Project)-[:HAS_PLAN]->(:Plan)`
- `(:Plan)-[:HAS_TASK]->(:Task)`
- `(:Task)-[:BLOCKED_BY]->(:Bug)`
- `(:Decision)-[:INFLUENCES]->(:Plan)`
- `(:Experiment)-[:VALIDATES]->(:Decision)`

**Rule:** never create cross‑project relationships unless explicitly requested; if needed, record an observation like `cross_project_link: true`.
### K) Example MCP tool payloads (for manual validation)
**Resolve project:**
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

**Upsert embedding profile with HNSW + query tuning:**
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

**Commit canonical doc:**
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

**Hybrid search:**
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
### L) First‑pass (delta plan) features still in effect
**Vector index tuning:**
- `packages/core/src/vector/indexManager.ts` supports per‑profile HNSW params from `embedding_profiles.provider_config.hnsw` (`m`, `ef_construction`).
- Index validation now compares opclass, dims, predicate, and HNSW params; mismatches trigger drop/recreate.

**Dynamic `hnsw.ef_search`:**
- `packages/core/src/search/semantic.ts` computes `ef_search` from `provider_config.query` with min/factor/max clamp.
- `SET LOCAL hnsw.ef_search` is applied per query in the Stage A transaction.

**Fusion changes:**
- Canonical/pinned boosts are implemented as **RRF channels** (ranked lists) instead of constant additive bumps.
- Trigram lane is included as its own channel when enabled.
- Internal weight profiles (`default`, `technical`, `conversational`, `code`) are inferred in `packages/core/src/search/search.ts`.

**Contextual embeddings (canonical docs only):**
- `embedVersion` uses contextual embedding for canonical doc classes: `app_spec`, `feature_spec`, `implementation_plan`.
- Voyage uses `/v1/contextualizedembeddings`; Jina uses `late_chunking`.
- Chunk overlap is disabled for canonical docs (second pass change in ingest).

**MCP resources:**
- `packages/mcp-server/src/resources.ts` registers `memory://` resources for list/read.
- Requires `projects.resolve` prior to `resources/list`.
### M) Operational notes (production behavior)
- **HNSW index build:** Large values of `m` / `ef_construction` increase build time and memory; consider `maintenance_work_mem` for large indexes.
- **`ef_search` tuning:** Higher values improve recall but increase latency. Per‑profile `provider_config.query` controls search behavior.
- **Outbox leases:** Set `OUTBOX_LEASE_SECONDS` higher than the worst‑case embed job time; long jobs can otherwise be reclaimed prematurely.
- **Backoff behavior:** Deterministic exponential backoff reduces load spikes; no jitter means retries can align across workers under heavy failure.
- **BM25:** Keep `pg_search` optional; if deployed, monitor operator/function availability, especially across ParadeDB/Neon variations.
- **Chunker offsets:** Since offsets slice the original markdown, any content normalization should happen **before** chunking.
### N) Workspace state notes
- The working tree is **dirty** with many pre‑existing modified/untracked files unrelated to this session’s changes (e.g., docs, dist outputs, local files, `.env.example`).
- Do **not** delete or revert unrelated changes unless explicitly requested by the user.
- When preparing commits, scope to the files listed in the “Files modified/added in this session” section.
### O) Migration catalog (high‑signal summary)
**Migrations are applied in filename order.** Key ones for this workstream:
- `0001_extensions.sql` — installs core extensions (`pgcrypto`, `vector`, `pg_trgm`, etc.). Required for vector storage and trigram search.
- `0002_tenancy.sql` — creates `workspaces` and `projects`, with unique `workspace_id + project_key`.
- `0003_sessions_commits.sql` — audit trail (`sessions`, `commits`), idempotency key constraint per project.
- `0004_memory_items_versions.sql` — memory item/version tables and enums; unique `canonical_key` per project.
- `0005_canonical_docs.sql` — canonical registry linking `canonical_docs` to `memory_items`.
- `0006_chunking.sql` — `memory_chunks` with `heading_path`, `section_anchor`, `start_char/end_char`, `tsv` + indexes.
- `0007_embeddings.sql` — `embedding_profiles`, `chunk_embeddings`, and expression index pattern for pgvector.
- `0008_links_outbox_sources.sql` — `memory_links`, `outbox_events`, `ingest_sources`.
- `0009_triggers.sql` — project_id propagation triggers and cross‑table consistency checks.
- `0010_outbox_leases.sql` — adds legacy fields: `processing_started_at`, `processing_expires_at`, `attempts`, and an index on `processing_expires_at` (now unused by worker).
- `0011_embedding_profiles_active_unique.sql` — enforces single active profile per project.
- `0012_indexes_doc_class_tags.sql` — indexes to speed doc_class/tag filtering.
- `0013_outbox_retries.sql` — adds `retry_count`, `next_attempt_at`, `locked_at`, `locked_by`, and an index on `next_attempt_at`.
- `0014_outbox_lease_expiry.sql` — **added this session**; adds `lease_expires_at` + index.
- `0090_optional_bm25_pg_search.sql` — **optional**; installs `pg_search` and creates `idx_chunks_bm25`.
### P) Table invariants and practical schema notes
**`embedding_profiles`**
- Columns: `id`, `project_id`, `name`, `provider`, `model`, `dims`, `distance`, `is_active`, `provider_config`.
- `provider_config` now holds `hnsw` (index tuning), `query` (ef_search tuning), and `late_chunking` (Jina contextual mode).
- Only one active profile per project (via `0011` migration).

**`chunk_embeddings`**
- Columns: `chunk_id`, `embedding_profile_id`, `embedding` (dimensionless vector).
- Index pattern: partial HNSW expression index per profile:
  - `USING hnsw ((embedding::vector(dims)) <opclass>) WHERE embedding_profile_id = '<profileId>'`.
- Semantic search explicitly casts `embedding::vector(dims)` to use the HNSW index.

**`memory_chunks`**
- Offsets (`start_char`, `end_char`) are now source‑aligned; `chunk_text` is an exact slice.
- `heading_path` and `section_anchor` drive resource slicing for `memory://` section URIs.
- `tsv` field uses `to_tsvector('english', chunk_text)`.

**`outbox_events`**
- Core: `id`, `project_id`, `event_type`, `payload`, `created_at`, `processed_at`, `error`.
- Retry: `retry_count`, `next_attempt_at`.
- Lease: `locked_at`, `locked_by`, `lease_expires_at`.
- Legacy: `processing_started_at`, `processing_expires_at`, `attempts` (no longer used by worker).
### Q) Research‑driven clarifications (why certain choices were made)
- **`SET LOCAL hnsw.ef_search` inside a transaction:** pgvector docs and vendor guides explicitly recommend `SET LOCAL` within a transaction for query‑scoped changes. This avoids leaking settings across pooled connections and aligns with the two‑stage semantic query pattern.
- **HNSW index parameters syntax:** `CREATE INDEX ... USING hnsw ... WITH (m = X, ef_construction = Y)` is the canonical form in pgvector docs and vendor guidance; this matches the existing indexManager implementation.
- **BM25 operator variance:** ParadeDB docs show `@@@` and `paradedb.score`, while prior implementations (and existing migration) use `|||` and `pdb.score`. Capability detection is required to avoid hard failures.
- **Outbox lease pattern:** `FOR UPDATE SKIP LOCKED` in a short transaction is the standard pattern for concurrent polling, especially in multi‑worker environments.
### R) Example runtime env configuration (non‑secret)
```bash
# Database
DATABASE_URL=postgres://user:pass@localhost:5432/memento

# Worker lease/retry controls
WORKER_ID=dev-worker-1
OUTBOX_LEASE_SECONDS=180
OUTBOX_RETRY_DELAY_SECONDS=5
OUTBOX_RETRY_MAX_DELAY_SECONDS=600
OUTBOX_MAX_ATTEMPTS=5

# Embedding throughput
EMBED_BATCH_SIZE=32
EMBED_CONCURRENCY=2

# Embedders (do not commit secrets)
EMBEDDER_BASE_URL=https://api.voyageai.com
EMBEDDER_API_KEY=***
EMBEDDER_USE_FAKE=false
```
### S) Hybrid retrieval configuration (recap)
- **Lexical lane:** FTS + trigram (or BM25 if available) in `packages/core/src/search/lexical.ts`.
- **Semantic lane:** pgvector ANN + filters in `packages/core/src/search/semantic.ts`.
- **Fusion (RRF):** `packages/core/src/search/fusion.ts` with weights:
  - default lexical 0.4, semantic 0.5, trigram 0.1
  - canonical boost 0.1 (ranked list channel)
  - pinned boost 0.1 (ranked list channel)
- **Weight profiles** inferred in `packages/core/src/search/search.ts`:
  - `code` profile for code‑like queries (identifiers, stack traces)
  - `conversational` for longer natural language
  - `technical` for short normal queries

If fusion results are unexpectedly dominated by canonical docs, reduce `canonical_boost` or adjust per‑profile weights.
### T) End‑to‑end local smoke test playbook
1. **Start DB**
   ```bash
   cd /Users/brennanconley/vibecode/memento
   docker compose up -d
   ```
2. **Apply migrations**
   ```bash
   for f in migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
   ```
   Verify `outbox_events` has `lease_expires_at` and `retry_count`.
3. **Build packages**
   ```bash
   pnpm -r build
   ```
4. **Start worker**
   ```bash
   WORKER_ID=dev-worker-1 node packages/worker/dist/main.js
   ```
5. **Start MCP server**
   ```bash
   node packages/mcp-server/dist/main.js
   ```
6. **In MCP client:**
   - Call `projects.resolve` and `sessions.start`.
   - Upsert embedding profile with `provider_config.hnsw` and `provider_config.query`.
   - Commit a canonical doc + a non‑canonical note.
7. **Verify worker activity:**
   - `SELECT * FROM outbox_events WHERE processed_at IS NULL;` should empty out.
   - `SELECT count(*) FROM memory_chunks WHERE version_id = ...;`
   - `SELECT count(*) FROM chunk_embeddings WHERE embedding_profile_id = ...;`
8. **Search validation:**
   - Run `memory.search` for both natural language and code‑like queries.
   - Ensure canonical items appear strongly but not overwhelmingly.
9. **Resource validation:**
   - `resources/list` returns memory URIs.
   - `resources/read` works for latest item, a version, and a section anchor.
### U) Search filter notes (Stage B behavior)
`appendItemFilters` currently supports:
- `kinds`, `scopes` (array filters on `mi.kind`, `mi.scope`).
- `pinned_only`, `canonical_only` (booleans).
- `doc_classes` (array filter on `mi.doc_class`).
- `tags_all` / `tags_any` (array containment overlap).
- `created_after` (timestamp filter).
- `item_ids` (inclusive list only; there is no exclusion filter today).

If a future feature requires excluding item IDs, add a new filter (e.g., `exclude_item_ids`) and apply it in Stage B, then increase candidate oversampling as needed.
### V) Contextual embeddings (canonical docs)
- `embedVersion` checks canonical status by joining `memory_items` + `canonical_docs`.
- Canonical detection rules: `canonical_docs` row exists **or** `memory_items.canonical_key` is set.
- Contextual embedding is **only** used for doc classes: `app_spec`, `feature_spec`, `implementation_plan`.
- Provider rules:
  - **Voyage:** contextual endpoint `/v1/contextualizedembeddings`, model must support contextual mode (e.g., `voyage-context-3`).
  - **Jina:** contextual mode only when `provider_config.late_chunking = true`.
- Overlap for canonical docs is forced to 0 during ingest to avoid contextual chunk duplication.
### W) HNSW index verification (per profile)
To confirm per‑profile HNSW params are applied:
```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE indexname LIKE 'chunk_embeddings_hnsw_%';
```
Expected `indexdef` contains `WITH (m = X, ef_construction = Y)` for the embedding profile.
### X) Outline and section slicing behavior
- `packages/core/src/chunking/outline.ts` builds section outlines from chunk metadata.
- Each `section_anchor` aggregates min/max `start_char/end_char` across chunks.
- MCP resource `memory://.../sections/{section_anchor}` uses these offsets to slice the original `content_text`.
- With the new chunker, offsets are stable and deterministic for resource slicing.
### Y) Pseudocode summaries (fast mental model)
**Worker polling loop (simplified):**
```
loop:
  leased = claimEvents(batchSize, leaseSeconds, workerId)
  for each event in leased:
    try:
      handler(event, pool)   # handler manages its own DB tx
      finalizeEventSuccess(event.id)
    catch err:
      finalizeEventFailure(event.id, err)
  sleep if no work
```

**INGEST_VERSION handler (simplified):**
```
version = SELECT memory_versions + memory_items + canonical_docs
markdown = normalize(content)
chunks = chunkMarkdown(markdown, overlap=0 if canonical)
BEGIN
  DELETE FROM memory_chunks WHERE version_id = $1
  INSERT new chunks (batched), chunk_text = markdown.slice(start,end)
COMMIT
```

**EMBED_VERSION handler (simplified):**
```
profile = loadEmbeddingProfile(project_id)
chunks = SELECT memory_chunks for version
vectors = embedder.embed(...)           # no DB tx
BEGIN
  INSERT/UPSERT into chunk_embeddings
COMMIT
```

**Semantic search (simplified):**
```
vector = embed(query)
BEGIN
  SET LOCAL hnsw.ef_search
  candidates = ANN query on chunk_embeddings
COMMIT
results = join candidates -> chunks -> versions -> items, apply filters
return matches
```
### Z) Future enhancements (not started, suggested)
- **Metrics / observability:** add Prometheus metrics behind `METRICS_PORT` with counters for outbox throughput, failures, and latency.
- **Search quality regression suite:** create golden search fixtures for lexical/semantic/fusion, especially for canonical vs non‑canonical queries.
- **Exclude filters:** add `exclude_item_ids` or similar to `SearchFilters` and handle in Stage B with candidate oversampling.
- **Chunker overlap tuning:** consider explicit rules for overlap by doc_class; update chunker tests accordingly.
- **Outbox cleanup:** consider an archival process for dead‑lettered events or a purge job.
- **BM25 config:** expose a feature flag to force BM25 off, even if available, for debugging.
