# Golden Test Suite Plan (Contract + Retrieval + Indexing)

This is an implementation plan for a *mechanical* test suite where outputs are stable and regressions are caught early.

---

## Test layers (in order)

### 1) Pure unit tests (no DB)

#### 1.1 Chunker unit tests (markdown)
Goal: deterministic chunking with stable anchors and no illegal splits.

**Inputs**
- markdown fixtures under `packages/core/test/fixtures/chunking/*.md`

**Assertions**
- Code fences are never split across chunks
- Tables are either kept intact or split only at row boundaries (if you implement table splitting)
- Each chunk has:
  - heading_path
  - section_anchor (stable slug)
  - chunk_index monotonic from 0..n-1
- Re-running chunker yields identical output byte-for-byte

**Golden files**
- `packages/core/test/golden/chunking/*.json` containing the expected chunk objects:
  - chunk_index
  - heading_path
  - section_anchor
  - start_char / end_char
  - chunk_text (or checksum of chunk_text)

Recommended approach:
- Store `sha256(chunk_text)` in golden to avoid huge snapshots, plus a short excerpt.

---

### 2) DB schema tests (migrations)

Goal: migrations apply cleanly, constraints behave as designed.

**Harness**
- docker compose Postgres with pgvector
- apply migrations in order

**Tests**
- Can create workspace/project
- Unique constraint on `(workspace_id, project_key)` enforced
- Unique constraint on canonical_key per project enforced
- Trigger-generated `updated_at` updates on memory_items update
- Trigger-set `project_id` propagation for versions/chunks/embeddings works
- pgvector expression index creation works for a dimensionless `vector` column (requires casting)

---

### 3) Tool contract tests (MCP tool handlers)

Goal: input/output shapes remain stable. The “contract” is the Zod output schemas.

**Approach**
- Call handlers directly (no MCP transport)
- Validate output using `ToolSchemas[tool].output.parse(output)`
- Use UUID scrubbing for snapshots, OR inject a deterministic ID generator.

**Fixtures**
- `packages/core/test/fixtures/tools/*.json`

**Goldens**
- `packages/core/test/golden/tools/*.json` expected outputs with:
  - UUIDs replaced by placeholders like "<uuid:commit_id>"
  - timestamps replaced by "<iso:...>"

---

### 4) Retrieval correctness tests (hybrid search)

Goal: exact recall + semantic recall + deterministic fusion.

**Setup**
- Insert canonical docs:
  - app_spec
  - feature_spec/auth
  - implementation_plan
- Insert troubleshooting entry with distinctive tokens (error codes, identifiers)
- Run ingestion worker in “inline test mode” to create chunks+tsv+embeddings

**Tests**
1) Exact keyword recall:
   - Query: "ECONNRESET", "TLS alert 40", etc.
   - Expect: troubleshooting chunk returned in top N via lexical side
2) Semantic recall:
   - Query: paraphrase of a spec section
   - Expect: correct canonical doc chunk in top N via vector side
3) Fusion invariants:
   - If lexical hit exists, it must appear in final merged results
   - Canonical docs are boosted when query includes "spec" or feature name

---

### 5) Idempotency & transactional guarantees

**Test cases**
- Same `idempotency_key` used twice for `memory.commit`:
  - first call creates commit_id
  - second call returns same commit_id with `deduped=true`
  - no extra versions created
- Partial failure injection:
  - simulate embedding service down
  - verify: commit succeeds, outbox events created, embeddings missing but recoverable

---

### 6) Worker tests (outbox processing)

Goal: worker processes events exactly-once in effect (idempotent processing).

**Tests**
- Insert outbox event `INGEST_VERSION` and run worker step:
  - processed_at set, chunks created
- Insert duplicate outbox event for same version:
  - worker must upsert / ignore duplicates safely

---

## Tooling recommendations

- Test runner: `vitest` or `jest`
- DB integration: `testcontainers` for Node or docker compose
- Snapshot normalization:
  - function to replace UUIDs with placeholders
  - function to replace ISO timestamps

---

## Definition of "done" for tests

- All migrations apply on a clean DB
- All tool outputs validate against output schemas
- Chunker goldens stable across runs
- Search tests deterministic with seeded embeddings (use test embedder stub)
