Below is a complete **prompt pack** you can hand to an agentic coder. It includes:

1. A **Master Prompt** (include this *with every phase/sub-phase prompt*).
2. A set of **Phase Prompts** and **Sub-phase Prompts** that kick off each build segment with:

   * goals
   * required deliverables
   * constraints and invariants
   * acceptance criteria
   * “what to return” instructions (so you always get usable outputs)

You can copy/paste exactly as written.
Recommended usage: **send the Master Prompt + exactly one sub-phase prompt at a time**.

---

# Master Prompt (include with every phase/sub-phase prompt)

```text
You are an agentic senior engineer implementing a production-grade MCP “memory server” using the low-level MCP SDK (NOT FastMCP). The system is called “Memento” and must provide durable, idempotent, versioned, multi-project memory for LLM coding sessions (Claude Code and OpenAI Codex TUI). Postgres is the system of record and pgvector is used for semantic retrieval; sparse retrieval must be supported (Postgres FTS + trigram; optional BM25 if installed).

You are working inside a repository that already contains:
- Zod tool schemas and tool name registry under packages/shared/
- SQL migrations under migrations/
- docs/testing.md describing golden test strategy
- example fixtures and expected outputs under packages/core/test/...
- a compose.yaml for pgvector-enabled Postgres

Absolute invariants (do not violate):
1) Low-level MCP SDK only. Do not use FastMCP or other opinionated wrappers.
2) STDIO transport must never write logs to stdout. stdout is reserved for JSON-RPC. Log to stderr (or file) only.
3) All tool inputs/outputs must conform to the Zod schemas in packages/shared/src/schemas.ts.
   - For every tool handler: parse input with ToolSchemas[tool].input and validate output with ToolSchemas[tool].output.
4) All writes must be atomic and idempotent:
   - Any write tool must require idempotency_key (per schema) and enforce dedupe per project.
   - Use a single Postgres transaction for each write tool.
5) Postgres is the source of truth. The worker builds derived indexes (chunks, embeddings) using an outbox mechanism.
6) Multi-project isolation must be enforced at the database/query layer using project_id (and workspace_id where applicable).
7) Embeddings:
   - Support Voyage, Jina, and OpenAI-compatible local embeddings endpoints via a unified embedder interface.
   - Store embeddings in Postgres pgvector using the “dimensionless vector column + per-profile partial expression index casting to vector(dims)” approach.
8) Sparse retrieval:
   - Baseline: Postgres FTS tsvector + ts_rank_cd + websearch_to_tsquery, plus trigram index for token-ish/code-ish recall.
   - Optional: if BM25 extension is installed, use it behind a feature flag; otherwise fall back.
9) Canonical specs/plans are first-class:
   - canonical_key is stable; canonical docs are pinned by default.
   - Support outline/section addressing (section_anchor + heading_path + char offsets).
   - Provide deterministic restore bundles and context packs.

Engineering standards:
- Prefer TypeScript + Node 20+ + pnpm workspaces (unless the repo already dictates otherwise).
- Write code that is explicit, testable, and observable (structured logging, clear errors).
- Implement careful error handling and return structured tool errors (not crashes).
- No “magic”: deterministic restore; deterministic chunking.
- Keep modules small and single-purpose.

When something is ambiguous:
- Choose the most conservative, production-safe default.
- Document the choice in code comments and/or docs, and proceed (do not ask questions unless absolutely blocked).

Your output format for each sub-phase:
A) A short “What changed” list (files added/modified).
B) How to run/test (commands).
C) Key implementation notes (decisions, caveats).
D) Anything left intentionally for a later phase (clearly labeled).

Proceed with the phase/sub-phase instructions that follow this master prompt.
```

---

# Phase 0 — Repository & Dev Environment Bootstrap

## Phase 0.1 Prompt — Monorepo bootstrap (pnpm + TS + lint/test skeleton)

```text
Goal: Turn the scaffold into a buildable, runnable monorepo with consistent TypeScript configuration and a test runner.

Deliverables:
1) Root package.json with pnpm workspaces pointing to packages/*
2) TypeScript configs:
   - tsconfig.base.json (shared strict settings)
   - per-package tsconfig.json extending base
3) Minimal build scripts:
   - pnpm -r build
   - pnpm -r test
   - pnpm -r lint (even if lint is minimal initially)
4) A minimal test harness (vitest or jest) in packages/core and packages/shared.

Constraints:
- Do not change the existing Zod schemas and migrations content.
- Only add config/build files necessary to compile and run tests.

Acceptance criteria:
- `pnpm install` succeeds.
- `pnpm -r build` succeeds (even if packages are stubs).
- `pnpm -r test` succeeds (even if only 1 placeholder test exists).

Return:
- Files changed
- Commands to run
- Any setup notes
```

## Phase 0.2 Prompt — Local dev runtime (compose + env + migration runner)

```text
Goal: Provide deterministic local dev setup: Postgres via docker compose and an app-level migration runner.

Deliverables:
1) A scripts/ directory with:
   - scripts/db-up.sh (runs docker compose up -d)
   - scripts/db-down.sh
   - scripts/migrate.sh (applies migrations in lexical order)
2) A .env.example with DATABASE_URL and embedder provider placeholders.
3) A minimal Node script (or shell) that can apply migrations and fail loudly.

Constraints:
- Must apply migrations in order and stop on first error.
- Must be safe to re-run (idempotent extensions, etc).
- No external dependencies beyond psql/docker OR pure Node + pg driver (pick one and be consistent).

Acceptance criteria:
- Fresh machine: db-up + migrate yields a valid schema.
- Re-running migrate causes no damage and exits successfully.

Return:
- Files changed
- Commands to run end-to-end
- Notes on prerequisites (docker, psql)
```

---

# Phase 1 — Database Access Layer & Core Primitives

## Phase 1.1 Prompt — Postgres client + transaction utilities + error model

```text
Goal: Implement a robust Postgres access layer and transaction helpers to support atomic tool operations.

Deliverables:
1) packages/core/src/db/:
   - pool.ts (connection pool)
   - tx.ts (transaction helper)
   - errors.ts (typed errors: NotFound, Conflict, Validation, etc.)
2) DB health check query function:
   - verify connectivity
   - verify pgvector extension present
3) A small query helper that enforces project scoping in every query (avoid cross-project contamination).

Constraints:
- Every write tool later must use tx() helper.
- Design errors so MCP handlers can return structured tool errors.

Acceptance criteria:
- Unit tests for tx helper (begin/commit/rollback semantics using a test DB).
- health check returns ok on running DB.

Return:
- Files changed
- How to run tests
- Notes on error mapping strategy
```

## Phase 1.2 Prompt — Workspace/project/session/commit repositories

```text
Goal: Implement repository modules for tenancy and auditing.

Deliverables (packages/core/src/repos/):
- workspaces.ts: create/get by name, list
- projects.ts: resolve project (workspace_id + project_key) with create_if_missing
- sessions.ts: start/end session
- commits.ts: insert-or-get commit by (project_id, idempotency_key)

Constraints:
- Commits must be idempotent: second attempt returns same commit id.
- Resolve project_key:
  - prefer repo_url hash if provided
  - fallback to cwd hash if provided
  - allow explicit project_key override for advanced usage

Acceptance criteria:
- Integration tests that:
  - create workspace/project
  - start/end session
  - commit idempotency works

Return:
- Files changed
- How to run integration tests
- Any schema assumptions
```

## Phase 1.3 Prompt — Memory repositories (items, versions, canonical_docs, links, outbox)

```text
Goal: Implement all core memory repository operations needed by the tool handlers.

Deliverables (packages/core/src/repos/):
- memoryItems.ts:
  - upsert item by item_id or canonical_key (project-scoped)
  - pin/unpin
  - archive/delete status
- memoryVersions.ts:
  - create new version with incrementing version_num per item
  - fetch latest or specific version
  - list history
- canonicalDocs.ts:
  - upsert canonical registry entry
  - get canonical item by key
- memoryLinks.ts:
  - create a link (project-scoped)
- outbox.ts:
  - enqueue events inside tx
  - poll events for worker later
  - mark processed/error

Constraints:
- Enforce project_id scoping in every query.
- Follow schema triggers: versions/chunks/embeddings project_id propagation should be respected.
- Do not implement chunking/embedding here; just enqueue outbox events.

Acceptance criteria:
- Integration tests verify:
  - canonical upsert creates memory_item + canonical_docs row
  - version numbers increment correctly
  - links are created and scoped
  - outbox event inserted and readable

Return:
- Files changed
- How to run tests
- Any performance considerations
```

## Phase 1.4 Prompt — pgvector index management utility per embedding profile

```text
Goal: Implement a safe function that creates (or ensures) the per-profile pgvector index using the correct expression+partial index pattern.

Deliverables:
- packages/core/src/vector/indexManager.ts with:
  - ensureProfileIndex(profile_id, dims, distance)
  - uses CREATE INDEX CONCURRENTLY where appropriate
  - records whether an index was created this call
- index naming convention:
  - chunk_embeddings_hnsw_<profileIdShort> or hashed name to keep it under identifier length limits

Constraints:
- The embeddings column is dimensionless VECTOR and must be cast in the index expression to vector(dims).
- Only index rows for the given profile (partial index WHERE embedding_profile_id = ...).
- Support cosine (default), l2, ip operators.

Acceptance criteria:
- Integration test:
  - create embedding profile
  - ensureProfileIndex runs successfully
  - verify index exists afterward via pg_catalog

Return:
- Files changed
- How to run tests
- Notes about CONCURRENTLY and transaction boundaries
```

---

# Phase 2 — MCP Server (Low-level SDK, STDIO)

## Phase 2.1 Prompt — MCP server process + tool registration + strict schema validation

```text
Goal: Create the MCP server process using STDIO transport and register all tools defined in packages/shared.

Deliverables (packages/mcp-server):
1) src/main.ts:
   - creates MCP server instance
   - STDIO transport
   - registers tools via registerTools.ts
   - logs to stderr only
2) src/registerTools.ts already exists; ensure it compiles against the pinned MCP SDK.
3) A server-side request context system:
   - track active workspace_id/project_id per connection (or per process if STDIO is single client)
4) For every tool handler:
   - parse input with ToolSchemas
   - validate output with ToolSchemas
   - return structured errors

Constraints:
- No FastMCP.
- Ensure no stdout logging.
- Tool handlers may be stubs at this stage, but must validate and return “not implemented” errors consistently.

Acceptance criteria:
- `pnpm -r build` succeeds.
- Running the server binary starts and advertises tools.
- Contract-level unit test can call handler functions.

Return:
- Files changed
- How to run the server locally
- Notes about SDK import/version pinning
```

## Phase 2.2 Prompt — Implement projects.resolve and sessions.start/end handlers

```text
Goal: Implement the first real tool handlers and prove the end-to-end DB integration.

Deliverables:
- projects.resolve handler:
  - resolves/creates workspace + project
  - sets active project context for the connection
  - returns ProjectsResolveOutput schema
- sessions.start handler:
  - inserts a sessions row
- sessions.end handler:
  - ends session
  - if create_snapshot=true:
    - requires idempotency_key
    - creates a session_snapshot memory item+version
    - enqueues outbox ingestion+embedding events

Constraints:
- Must be fully transactional for snapshot creation.
- Must obey idempotency rules.

Acceptance criteria:
- Tool contract tests for these handlers validate outputs against Zod output schemas.
- A DB integration test can:
  - resolve project
  - start session
  - end session with snapshot and see outbox events

Return:
- Files changed
- How to run tests
- Any notes about active project context management
```

## Phase 2.3 Prompt — Implement canonical.* and basic memory CRUD tools

```text
Goal: Implement canonical and basic memory CRUD tool handlers against the repositories.

Deliverables:
- canonical.upsert: creates/updates canonical memory item, version, canonical_docs row, outbox events
- canonical.get: fetch canonical item+version (truncate content to max_chars)
- memory.commit: batch upsert items + versions + links + outbox
- memory.get: get item by item_id or canonical_key
- memory.history: list versions
- memory.pin/unpin
- memory.archive
- memory.link

Constraints:
- Every write uses tx helper and idempotency_key.
- Enqueue INGEST_VERSION and EMBED_VERSION for new versions.

Acceptance criteria:
- Contract tests for each handler (input/output Zod validation).
- Integration tests confirm DB rows created and scoped.

Return:
- Files changed
- How to run tests
- Notes about batch behavior and idempotency handling
```

## Phase 2.4 Prompt — Implement health.check and minimal restore/search scaffolding

```text
Goal: Implement health.check fully and provide functional stubs for search/restore that will be upgraded later.

Deliverables:
- health.check:
  - database_ok
  - worker_backlog (count of unprocessed outbox events)
  - active_embedding_profile_id if any active
- memory.restore:
  - deterministic selection logic using DB (pinned canonical, latest snapshot, recent troubleshooting)
  - return resource URIs only (context_pack optional but can be empty until search is ready)
- memory.search:
  - placeholder lexical-only search using tsvector until embeddings are ready

Constraints:
- No model calls.
- Must respect max_items/max_chars.

Acceptance criteria:
- Contract tests for health/restore/search.
- Restore returns stable results given stable DB state.

Return:
- Files changed
- How to run tests
- What’s deferred to Phase 5 (hybrid ranking)
```

---

# Phase 3 — Worker (Outbox → Ingestion → Chunking → FTS)

## Phase 3.1 Prompt — Worker process + outbox polling framework

```text
Goal: Implement the worker runtime that polls outbox_events safely and processes jobs idempotently.

Deliverables (packages/worker):
- src/main.ts: starts loop, logs to stderr, graceful shutdown
- src/outboxPoller.ts:
  - SELECT ... FOR UPDATE SKIP LOCKED LIMIT N
  - marks processed_at on success
  - stores error on failure (without crashing the loop)
- job type dispatch:
  - INGEST_VERSION
  - EMBED_VERSION (stub for now)

Constraints:
- Must be safe with multiple worker instances (skip locked).
- Must not reprocess already processed events.

Acceptance criteria:
- Integration test that inserts an outbox event and worker processes it exactly once.

Return:
- Files changed
- How to run worker locally
- Notes about concurrency and retries
```

## Phase 3.2 Prompt — Markdown normalization + deterministic chunker (anchors + offsets)

```text
Goal: Implement the structure-preserving deterministic chunker for Markdown and store chunk metadata needed for canonical section addressing.

Deliverables (packages/core):
- src/chunking/normalize.ts:
  - normalize input to markdown (minimal; preserve as-is if already markdown)
- src/chunking/chunker.ts:
  - parse headings and blocks
  - keep code fences intact
  - produce chunks with:
    - chunk_index
    - heading_path[]
    - section_anchor (stable)
    - start_char/end_char offsets referencing the original content
- src/chunking/anchors.ts:
  - stable slugify rules; deterministic across runs

Constraints:
- Must be deterministic byte-for-byte.
- Must not split inside code fences.
- Must support large docs efficiently (low latency).

Acceptance criteria:
- Golden chunker tests:
  - stable outputs
  - anchor stability
  - no illegal splits

Return:
- Files changed
- How to run chunker tests
- Notes about token estimation strategy
```

## Phase 3.3 Prompt — INGEST_VERSION job handler: write memory_chunks + tsvector

```text
Goal: Implement INGEST_VERSION in the worker: create chunks and populate tsvector for sparse retrieval.

Deliverables:
- packages/worker/src/jobs/ingestVersion.ts:
  - loads memory_versions content_text
  - chunks it
  - inserts into memory_chunks (idempotent upsert)
  - computes tsvector (either in SQL via to_tsvector or in app logic)
- Ensure it does not create duplicate chunks on replay.

Constraints:
- Idempotent: re-running ingest for same version must not duplicate rows.
- Use the schema’s UNIQUE(version_id, chunk_index) constraint for upserts.

Acceptance criteria:
- Integration test:
  - create version + enqueue ingest event
  - run worker step
  - verify chunks exist, tsv non-null

Return:
- Files changed
- How to run worker ingest tests
- Notes about language config for to_tsvector
```

---

# Phase 4 — Embeddings (Voyage/Jina/OpenAI-Compat Local) + pgvector Index

## Phase 4.1 Prompt — Embedder clients + unified embedder interface

```text
Goal: Implement embedding provider clients behind a single interface.

Deliverables:
- packages/clients/src/embedder.ts (interface + types)
- packages/clients/src/voyage.ts
- packages/clients/src/jina.ts
- packages/clients/src/openaiCompat.ts
- packages/clients/src/index.ts

Constraints:
- Providers must support:
  - query embeddings (retrieval.query)
  - passage embeddings (retrieval.passage)
- All clients must be configurable via env:
  - base_url
  - api_key
  - model
  - dims (if required/configured)
- Implement robust retry/backoff hooks (or stub now but define the API).

Acceptance criteria:
- Unit tests with HTTP mocking validating request/response shapes.
- A “fake embedder” for integration tests that returns deterministic vectors.

Return:
- Files changed
- How to run unit tests
- Notes about provider-specific parameters
```

## Phase 4.2 Prompt — Embedding profiles tools + pgvector index creation integration

```text
Goal: Implement embedding_profiles.* tool handlers and tie them to index creation.

Deliverables:
- embedding_profiles.list/upsert/activate handlers in MCP server
- core repo methods for embedding_profiles
- on upsert (create) or activate:
  - ensure pgvector index exists for the profile via indexManager.ensureProfileIndex()

Constraints:
- Index creation may require running outside a tx if using CONCURRENTLY. Handle this carefully:
  - either create without concurrently, or run ensureProfileIndex after committing the tx.
- Enforce only one active profile per project.

Acceptance criteria:
- Integration test:
  - upsert a new profile
  - confirm index exists
  - activate it
  - verify active toggled correctly

Return:
- Files changed
- How to test index creation
- Notes about transaction boundary decisions
```

## Phase 4.3 Prompt — EMBED_VERSION job handler (batching, idempotent upserts)

```text
Goal: Implement EMBED_VERSION in the worker: embed each chunk and store in chunk_embeddings for the active embedding profile.

Deliverables:
- packages/worker/src/jobs/embedVersion.ts:
  - select chunks for version
  - embed texts in batches
  - insert into chunk_embeddings with upsert on (chunk_id, embedding_profile_id)
- Configurable batch size and concurrency limits.

Constraints:
- Idempotent: safe to rerun.
- Must handle temporary provider failures:
  - record outbox error and leave processed_at null or set error and require manual replay (choose one consistent strategy).
- Must embed queries and passages appropriately; this job embeds passage chunks.

Acceptance criteria:
- Integration test using fake embedder:
  - after embed job, chunk_embeddings row count equals chunk count
- Verify query embedding path is available for search later.

Return:
- Files changed
- How to run embed integration tests
- Notes about batching and rate limiting
```

---

# Phase 5 — Hybrid Search (Sparse + Semantic + Fusion)

## Phase 5.1 Prompt — Lexical retrieval query (FTS + trigram)

```text
Goal: Implement high-precision sparse retrieval for exact keywords and code tokens.

Deliverables:
- packages/core/src/search/lexical.ts:
  - FTS using websearch_to_tsquery + ts_rank_cd
  - trigram fallback/boost for token-ish queries
  - returns scored chunk matches with metadata (heading_path, section_anchor, excerpt)
- Configurable top_k.

Constraints:
- Must filter by project_id and optional filters (kinds/scopes/tags/pinned/canonical/doc_classes).
- Must be fast: appropriate indexes already exist.

Acceptance criteria:
- Integration test:
  - insert a troubleshooting entry containing a unique token like “ECONNRESET_42”
  - lexical search finds it in top results

Return:
- Files changed
- How to run lexical tests
- Notes about query parsing and escaping
```

## Phase 5.2 Prompt — Semantic retrieval query (pgvector ANN)

```text
Goal: Implement semantic retrieval via pgvector against chunk_embeddings for the active profile.

Deliverables:
- packages/core/src/search/semantic.ts:
  - embed query using active embedder profile
  - vector search using pgvector operator based on distance metric
  - returns scored chunk matches with metadata
- Ensure profile dims casting aligns with index design.

Constraints:
- Must filter to project_id and active embedding_profile_id.
- Must handle the case where embeddings are not ready yet (return empty semantic set, not error).

Acceptance criteria:
- Integration test with fake embedder:
  - semantic search returns expected chunk(s) for a paraphrased query

Return:
- Files changed
- How to run semantic tests
- Notes about score normalization (cosine similarity vs distance)
```

## Phase 5.3 Prompt — Fusion ranking (RRF) + grouping by item + canonical boosts

```text
Goal: Implement deterministic hybrid ranking and output formatting that matches MemorySearchOutput schema.

Deliverables:
- packages/core/src/search/fusion.ts:
  - Reciprocal Rank Fusion merge of lexical + semantic rankings
  - deterministic tie-breaking
  - canonical/pinned boost policy
- packages/core/src/search/search.ts:
  - orchestrates lexical + semantic + fusion
  - groups best chunks by item
  - returns memory.search results in required shape

Constraints:
- Ensure lexical hits are never lost: if lexical finds a chunk, it must be eligible for final results.
- Implement stable resource URIs:
  - memory://projects/{project_id}/items/{item_id}
  - optionally include @version and #anchor in chunk URIs

Acceptance criteria:
- Integration tests:
  - lexical-only query returns the right item
  - semantic-only query returns the right canonical spec section
  - mixed query returns both and ranks sensibly

Return:
- Files changed
- How to run hybrid tests
- Notes about determinism and tie-breaking
```

## Phase 5.4 Prompt — memory.restore upgrade + canonical.context_pack implementation

```text
Goal: Upgrade restore to optionally produce an actual context_pack using hybrid search and section metadata.

Deliverables:
- memory.restore handler:
  - deterministic bundle selection
  - if include_context_pack=true:
    - build context pack from top ranked chunks/sections until max_chars
- canonical.context_pack handler:
  - goal-driven selection within a canonical doc (prefer section anchors)

Constraints:
- Deterministic: no model calls.
- Must obey max_chars strictly.

Acceptance criteria:
- Contract tests pass.
- Integration test verifies context_pack includes excerpts + URIs and stays under size.

Return:
- Files changed
- How to test restore/context_pack end-to-end
- Notes about truncation logic
```

---

# Phase 6 — Canonical Outline & Section Addressing

## Phase 6.1 Prompt — canonical.outline (stable section inventory)

```text
Goal: Implement canonical.outline returning all sections with anchors, heading paths, and offsets.

Deliverables:
- Outline extraction stored during chunking OR computed from chunk metadata.
- canonical.outline handler returns:
  - sections[] { section_anchor, heading_path, start_char, end_char }

Constraints:
- Anchors must be stable and deterministic.
- Prefer deriving outline from the same logic as chunker to avoid drift.

Acceptance criteria:
- Unit test on a sample markdown fixture checks expected anchors and paths.

Return:
- Files changed
- How to run outline tests
- Notes about anchor stability guarantees
```

## Phase 6.2 Prompt — canonical.get_section (deterministic slicing)

```text
Goal: Implement canonical.get_section that returns the exact section text using stored offsets and/or chunk boundaries.

Deliverables:
- canonical.get_section handler:
  - find section by anchor
  - slice content_text using start_char/end_char if available
  - otherwise reconstruct from chunks belonging to anchor/path
  - enforce max_chars and set truncated flag

Constraints:
- Must be deterministic and not rely on embedding/search.
- Must handle missing offsets gracefully.

Acceptance criteria:
- Integration test:
  - upsert a canonical doc
  - ingest it
  - get_section returns correct text for a known anchor

Return:
- Files changed
- How to test section retrieval
- Notes about fallback behavior when offsets are null
```

---

# Phase 7 — Golden Tests & CI

## Phase 7.1 Prompt — Chunker golden tests (fixtures → golden JSON)

```text
Goal: Implement the golden test system for chunking described in docs/testing.md.

Deliverables:
- packages/core/test/chunking.test.ts
- fixtures under packages/core/test/fixtures/chunking/
- golden outputs under packages/core/test/golden/chunking/
- snapshot normalization rules:
  - store sha256(chunk_text) and a short excerpt to keep goldens small

Constraints:
- Tests must be deterministic across machines.

Acceptance criteria:
- Tests pass locally.
- Goldens are committed and stable.

Return:
- Files changed
- How to run tests
- Notes about updating goldens (and when allowed)
```

## Phase 7.2 Prompt — Tool contract tests (validate outputs against Zod output schemas)

```text
Goal: Implement contract tests that call handlers and validate ToolSchemas outputs.

Deliverables:
- packages/mcp-server/test/contract/*.test.ts (or similar)
- utilities:
  - uuid scrubber
  - timestamp scrubber
- Use fixtures from packages/core/test/fixtures/tools
- Compare normalized outputs to goldens under packages/core/test/golden/tools

Constraints:
- The Zod output parse must always be applied in tests (and should also be applied in handler runtime).

Acceptance criteria:
- Contract tests pass and catch schema drift.

Return:
- Files changed
- How to run contract tests
- Notes about placeholder normalization
```

## Phase 7.3 Prompt — Integration tests with Postgres + worker inline processing

```text
Goal: Create end-to-end integration tests that prove:
- commit → outbox → ingest → embed → search works

Deliverables:
- testcontainers-based Postgres setup (or docker-compose based harness)
- a “worker step” function to process a single outbox event synchronously in tests
- tests:
  1) canonical.upsert → ingest → outline/get_section
  2) troubleshooting entry → lexical search hit
  3) semantic search hit using fake embedder
  4) hybrid fusion invariants

Constraints:
- Tests must be reliable and not depend on real external embedding services.

Acceptance criteria:
- All integration tests pass locally.

Return:
- Files changed
- How to run integration tests
- Notes about test runtime and flakiness avoidance
```

---

# Phase 8 — Operational Polish (Admin Tools, Observability, Docs)

## Phase 8.1 Prompt — Admin tools reindex/reingest + replay strategy

```text
Goal: Implement admin tools and a clean replay story for ingestion/embedding.

Deliverables:
- admin.reingest_version:
  - enqueue INGEST_VERSION (+ optionally EMBED_VERSION)
- admin.reindex_profile:
  - enqueue REINDEX_PROFILE which re-embeds all chunks for a project/profile
- Worker handlers for these events (safe, idempotent).

Constraints:
- Must be safe at scale: process in batches, avoid long transactions.

Acceptance criteria:
- Integration test:
  - mark embeddings missing
  - reindex_profile repopulates them

Return:
- Files changed
- How to test replay tools
- Notes about batch sizing and safety
```

## Phase 8.2 Prompt — Observability (structured logs + backlog metrics)

```text
Goal: Add structured logs and minimal metrics.

Deliverables:
- Structured logging library configured to stderr.
- health.check already returns backlog count; add:
  - worker loop logs (processed count, error count)
  - optional Prometheus endpoint (if you choose) OR a simple periodic metric log line

Constraints:
- Do not add excessive dependencies. Keep it minimal and production-friendly.

Acceptance criteria:
- Logs are parseable JSON or consistent structured format.
- health.check reflects backlog correctly.

Return:
- Files changed
- How to observe logs locally
- Notes about metrics strategy
```

## Phase 8.3 Prompt — Developer documentation (how to configure Claude Code + Codex TUI)

```text
Goal: Provide clear runbooks for developers to use the MCP server locally and connect clients.

Deliverables:
- docs/USAGE.md:
  - start db, migrate, run server, run worker
  - how to register server in Claude Code (project-scoped and user-scoped)
  - how to register server in Codex TUI
- docs/TROUBLESHOOTING.md:
  - common failures (db down, migrations missing, embedding provider errors)
  - how to replay outbox / run admin tools

Constraints:
- Be explicit, include example config snippets, avoid ambiguity.

Acceptance criteria:
- A new developer can follow docs and be running in < 15 minutes.

Return:
- Files changed
- Summary of docs content
- Any assumptions made about client config locations
```

---

## Optional: “One-button phase runner” prompts

If you want the agentic coder to work more autonomously, you can also send *Phase-level* prompts that bundle several sub-phases. But I recommend staying at sub-phase granularity so you can review each checkpoint.

---

If you tell me which agentic coding environment you’re using (Claude Code agent, Codex agent, Cursor agent, etc.), I can also tailor the prompts to that environment’s strengths (e.g., whether it supports multi-file patch application, whether it can run docker/testcontainers, etc.).
