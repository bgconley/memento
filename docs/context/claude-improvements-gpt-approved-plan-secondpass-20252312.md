Below are **second pass post-MVP integration plans**

Each section includes:

* **What to implement** (additional items)
* **Exactly how to integrate it after the original plan and first post-deployment implementation is complete**
* **DB migrations (if needed)**
* **Concrete code touchpoints (file-level)**
* **Test additions (to prevent regressions)**
* **Operational notes (so it behaves well in production)**

---

# 1) Worker pattern: do NOT “BEGIN; claim; do network IO; COMMIT”

## Why not as written (the failure mode)

## What to implement 

Implement a **lease-based outbox** with **short claim transactions** and **work outside locks**:

### State model (single table, explicit states)

* **Ready**: `processed_at IS NULL` AND `(next_attempt_at IS NULL OR next_attempt_at <= now())` AND `lease_expires_at IS NULL OR lease_expires_at < now()`
* **Leased**: `lease_expires_at > now()` and `locked_by` set
* **Done**: `processed_at IS NOT NULL`
* **Dead-letter**: `retry_count >= MAX_RETRIES` (kept in table, but excluded from polling)

### Core invariants

1. Claiming work is quick and transactional.
2. Processing work may take long, but **does not hold DB locks**.
3. Each event is processed with “exactly-once effect” via idempotent writes (UPSERT + unique constraints).

---

## How to integrate after first pass post-MVP implementation (PR-ready checklist)

### A) DB migration (new file)

Add: `migrations/0010_outbox_leases.sql`

```sql
ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- Efficient polling for ready work
CREATE INDEX IF NOT EXISTS outbox_events_ready_idx
  ON outbox_events (created_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS outbox_events_next_attempt_idx
  ON outbox_events (next_attempt_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS outbox_events_lease_idx
  ON outbox_events (lease_expires_at)
  WHERE processed_at IS NULL;
```

> Keep your existing `outbox_events_unprocessed_idx`; this is additive.

---

### B) Worker poller rewrite (claim → process → finalize)

Edit: `packages/worker/src/outboxPoller.ts`

Implement **three functions**:

#### 1) `claimEvents(batchSize, leaseMs, workerId)`

**Runs inside a short transaction** and returns the claimed rows.

**Recommended claim SQL pattern** (single statement claim + return):

```sql
WITH candidate AS (
  SELECT id
  FROM outbox_events
  WHERE processed_at IS NULL
    AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
    AND retry_count < $1
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE outbox_events e
SET locked_at = now(),
    locked_by = $3,
    lease_expires_at = now() + make_interval(secs => $4)
FROM candidate
WHERE e.id = candidate.id
RETURNING e.*;
```

Parameters:

* `$1 = MAX_RETRIES`
* `$2 = batchSize`
* `$3 = workerId`
* `$4 = leaseSeconds`

**Important:** This transaction should contain *only* the claim query and a commit.

#### 2) `processEvent(event)`

**Runs outside the claim transaction**, may do IO.

* For `INGEST_VERSION`: compute chunks and write them (DB tx only around writes)
* For `EMBED_VERSION`: call embedder outside DB tx, then write embeddings in a DB tx

#### 3) `finalizeEventSuccess(eventId)`

Single UPDATE:

```sql
UPDATE outbox_events
SET processed_at = now(),
    error = NULL,
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL
WHERE id = $1;
```

#### 4) `finalizeEventFailure(eventId, err)`

Compute backoff:

* `retry_count += 1`
* `next_attempt_at = now() + backoff(retry_count)`
* clear the lease columns

```sql
UPDATE outbox_events
SET error = $2,
    retry_count = retry_count + 1,
    next_attempt_at = $3,
    locked_at = NULL,
    locked_by = NULL,
    lease_expires_at = NULL
WHERE id = $1;
```

**Backoff recommendation (deterministic):**

* base = 5s
* factor = 2
* max = 10m
* jitter optional (but deterministic jitter is hard; you can omit jitter)

---

### C) Rewrite job handlers to avoid “work inside tx”

#### For `INGEST_VERSION`

Edit: `packages/worker/src/jobs/ingestVersion.ts`

**Correct pattern**:

1. DB read content (short tx or single query)
2. chunk in memory (no tx)
3. DB write chunks (tx)

**Write strategy (idempotent & safe):**
Because versions are immutable, the simplest robust approach is:

* In a transaction:

  * `DELETE FROM memory_chunks WHERE version_id = $1;`
  * Insert all new chunks
  * Commit

This prevents “leftover old chunks” if you ever change chunking config and re-ingest.

#### For `EMBED_VERSION`

Edit: `packages/worker/src/jobs/embedVersion.ts`

**Correct pattern**:

1. DB read profile + chunk texts (single query)
2. call embedder (no tx)
3. DB write embeddings (tx; upsert)
4. commit

Optional hardening:

* If chunk count is huge, do “read chunk ids + texts” in pages.

---

### D) Tests to add (must-have)

Add integration tests under: `packages/worker/test/outboxLease.test.ts`

Test cases:

1. **Lease prevents double-processing**

   * Insert one outbox event
   * Start two workers concurrently (or simulate two claim calls with different workerId)
   * Assert only one claims the event

2. **Failure increments retry_count and schedules next_attempt_at**

   * Insert event that will fail (mock handler throws)
   * Run worker once; assert:

     * processed_at is NULL
     * retry_count is 1
     * next_attempt_at is set and in the future

3. **Dead-letter behavior**

   * Set retry_count = MAX_RETRIES - 1
   * Fail it again
   * Ensure poller no longer claims it

---

### E) Operational integration notes

* Use `workerId = hostname:pid` or random UUID.
* Set `leaseSeconds` > expected max processing time for a single job (e.g. 120s).
* If a worker crashes mid-job, lease expiry returns job to the queue.

---

# 2) Semantic SQL: adapt it to our schema and preserve index usage

## Why not as written (mismatch + planner risk)

In our plan, vectors live in:

* `chunk_embeddings(embedding_profile_id, embedding, chunk_id)`
* `memory_chunks(id, version_id, chunk_text, ...)`

That’s the right design (multi-profile), but the correct SQL must be written.

Also: joining too early can (sometimes) cause the planner not to use the ANN index efficiently.

## What to implement (correct approach)

Use a **two-stage query**:

1. **Stage A:** use HNSW index on `chunk_embeddings` only
2. **Stage B:** join the *small candidate set* to `memory_chunks → memory_versions → memory_items` to apply filters and produce results

If you need to exclude items or apply complex filters, do it in stage B, and simply request more candidates in stage A (e.g. `semantic_top_k * 4`) to avoid losing recall.

---

## How to integrate after first pass post-MVP implementation (PR-ready checklist)

### A) Implement a “vector candidate query” that guarantees index use

Edit: `packages/core/src/search/semantic.ts`

Use this query shape:

```sql
-- Stage A: index-friendly ANN candidate generation
SELECT
  ce.chunk_id,
  ce.embedding_profile_id,
  (ce.embedding::vector($DIMS) <=> $QUERY_VEC::vector($DIMS)) AS distance
FROM chunk_embeddings ce
WHERE ce.embedding_profile_id = $PROFILE_ID
ORDER BY ce.embedding::vector($DIMS) <=> $QUERY_VEC::vector($DIMS)
LIMIT $CANDIDATES;
```

Then in code:

* collect chunk_ids
* do a second query:

```sql
-- Stage B: join and apply filters only on small set
SELECT
  mc.id AS chunk_id,
  mv.item_id,
  mv.version_num,
  mc.heading_path,
  mc.section_anchor,
  LEFT(mc.chunk_text, $EXCERPT_CHARS) AS excerpt,
  t.distance
FROM (VALUES
  -- (chunk_id, distance) pairs
) AS t(chunk_id, distance)
JOIN memory_chunks mc ON mc.id = t.chunk_id
JOIN memory_versions mv ON mc.version_id = mv.id
JOIN memory_items mi ON mv.item_id = mi.id
WHERE mi.project_id = $PROJECT_ID
  AND mi.status = 'active'
  -- optional filters: kind/scope/tags/canonical/pinned
ORDER BY t.distance ASC;
```

### B) Handle “exclude item_id” safely

If you need `mv.item_id != excluded_item_id`:

* do it in stage B
* increase `CANDIDATES` so you still return enough hits

Rule of thumb:

* `CANDIDATES = semantic_top_k * 4` (or *8* for heavy filtering)

### C) Add `SET LOCAL hnsw.ef_search` *in the same transaction* as Stage A

As in the earlier recommendation:

* start tx
* `SET LOCAL hnsw.ef_search = ...`
* run Stage A
* commit

This ensures the setting affects the query and doesn’t leak to pooled connections.

### D) Tests

Add integration tests verifying:

* semantic query returns the expected chunk(s)
* stage B filters do not crash results
* if you exclude an item, you still get enough results when `CANDIDATES` is raised

---

# 3) Chunker offsets



Offsets must refer to exact indices of the original `content_text`.

## What to implement instead (correct deterministic offset model)

Implement the chunker as **block slices** of the original markdown string:

1. Parse markdown into ordered **blocks** each with:

   * `start_char`, `end_char` (indices in the original string)
   * `type` (heading, paragraph, list, code fence, table, blank line)
   * `heading_path` at that point

2. A chunk is a contiguous run of blocks.

3. Chunk offsets are:

   * `chunk.start_char = blocks[first].start_char`
   * `chunk.end_char = blocks[last].end_char`

4. Chunk text is:

   * `markdown.slice(chunk.start_char, chunk.end_char)`

**Key invariant you can test**:

> `chunk_text === original.slice(start_char, end_char)`

That makes section extraction and anchor addressing reliable forever.

---

## How to integrate after first pass post-MVP implementation (PR-ready checklist)

### A) Refactor chunker to produce blocks with absolute offsets

Edit:

* `packages/core/src/chunking/chunker.ts`
* `packages/core/src/chunking/normalize.ts`
* `packages/core/src/chunking/anchors.ts`

Add:

* `packages/core/src/chunking/blocks.ts` (recommended)

**Block structure:**

```ts
type Block = {
  type: "heading" | "paragraph" | "list" | "code_fence" | "table" | "blank";
  start: number; // char index into original markdown
  end: number;   // char index into original markdown
  headingLevel?: number;
  headingText?: string;
};
```

**Parsing approach (deterministic, low-latency, no heavy markdown AST required):**

* Scan line-by-line, tracking absolute character index.
* Detect:

  * headings: `^#{1,6} `
  * code fences: lines starting with ``` (and capture until closing fence)
  * tables: consecutive lines containing `|` with a separator row (optional; you can treat as paragraph if you want)
  * blank lines
  * paragraphs/lists: group adjacent non-blank non-heading lines until blank line boundary

### B) Chunk assembly uses block offsets, not constructed lengths

When adding blocks to a chunk, you compute token estimate from the substring slice, but you never “rebuild” the text. You just choose block boundaries.

### C) Overlap handling (if enabled)

If you keep overlap:

* overlap must also be block-based, and chunks can overlap in original offsets.
* But **do not** use overlap for contextual embedding modes.

### D) Update ingest job to trust chunker offsets

Edit: `packages/worker/src/jobs/ingestVersion.ts`

* store `start_char/end_char` as chunker outputs
* store `chunk_text` as slice from original markdown using those offsets

### E) Tests (must-have)

Add unit test:

* for every chunk:

  * `expect(chunkText).toEqual(original.slice(start, end))`

Add golden fixture(s):

* include headings + code fences + lists
* verify anchors and heading_path stability

---

# 4) ParadeDB pg_search syntax/version sensitivity:

## Why not as written (real-world breakage)

## What to implement instead (safe, future-proof strategy)

Implement BM25 as an **optional capability** with:

1. **startup detection**:

   * extension exists?
   * bm25 index exists?
2. **“try it, and fail open”**:

   * if BM25 query errors with “undefined function/operator”, disable BM25 and fall back to FTS for that process lifetime
3. a clean separation:

   * `lexicalBm25.ts`
   * `lexicalFts.ts`
   * dispatcher chooses which to call

This makes the system robust across environments.

---

## How to integrate after first pass post-MVP implementation (PR-ready checklist)

### A) Capability detection module

Add: `packages/core/src/search/bm25/capabilities.ts`

* `isPgSearchInstalled(): boolean`
* `hasBm25IndexOnMemoryChunks(): boolean`
* `getPgSearchVersion(): string | null`

Example detection queries:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'pg_search';
```

Index existence:

```sql
SELECT 1
FROM pg_indexes
WHERE tablename = 'memory_chunks'
  AND indexdef ILIKE '%USING bm25%';
```

### B) BM25 query module (current docs path)

Add: `packages/core/src/search/bm25/lexicalBm25.ts`

Use the docs-recommended:

* `|||` operator
* `pdb.score(id)` pattern

### C) Fail-open fallback

In the dispatcher:

* if BM25 enabled:

  * run BM25 query inside a try/catch
  * if it fails due to missing operator/function:

    * set `bm25Available=false`
    * log warning
    * rerun as FTS

### D) Tests

* Always-on tests: ensure FTS path works.
* Optional tests: only run BM25 tests when extension is available (conditional test suite).

---

Second pass post-MVP implementation:

If you want these to be applied cleanly after finishing the original build, do them in this sequence:

1. **PR‑A:** Worker lease + retry/backoff + short claim tx (most important reliability fix)
2. **PR‑B:** Semantic search query rewrite (two-stage ANN candidate + join)
3. **PR‑C:** Chunker offset refactor (block slices, offsets from original)
4. **PR‑D:** Optional BM25 capability detection + fail-open fallback

---


