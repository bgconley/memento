A lot of what’s in that “Enhanced Specification” has real merit.

Below is a precise, implementable “delta plan” you can apply **after** you finish the ORIGINAL plan (schemas/tools/worker/search as we designed). I’ll break this into:

* **A. Add/Integrate (high value)** — I recommend implementing these.
* **B. Add/Integrate (optional / environment-dependent)** — worth it if you can support it cleanly.
* **C. Exact integration steps** — where to change code, what migrations/config/tests to add.

I’ll also call out where the enhanced spec has factual or practical mismatches.

---

## A) Add / Integrate (high value; should be implemented)

### 1) pgvector HNSW tuning as *first-class config* (per embedding profile)

**Merit:** High. You will absolutely want per-profile control over HNSW build parameters and per-query `ef_search` for recall/latency tradeoffs.

**What’s correct in the enhanced spec:**

* pgvector supports HNSW parameters `m` and `ef_construction` in `CREATE INDEX ... USING hnsw ... WITH (...)`. Defaults commonly referenced are `m=16`, `ef_construction=64`. ([Amazon Web Services, Inc.][1])
* `hnsw.ef_search` is query-time tunable; pgvector documents using `SET` and `SET LOCAL` for per-transaction tuning. ([GitHub][2])
* Default `hnsw.ef_search` is 40. ([GitHub][2])
* `ef_search` should generally be **>= LIMIT k** (because it’s your candidate pool). ([Neon][3])

**Important correction:**

* `ef_search` **does not cap returned results**. `LIMIT` caps returned results. `ef_search` caps the internal candidate list size (affecting recall). ([GitHub][2])

✅ **Implement:**

* Store HNSW index params in `embedding_profiles.provider_config` (no schema changes required).
* Update `ensureProfileIndex()` to use `WITH (m=..., ef_construction=...)`.
* Update semantic search to dynamically set `SET LOCAL hnsw.ef_search = ...` **inside a transaction on the same connection** used for the vector query. ([GitHub][2])

---

### 2) Hybrid retrieval improvements: keep RRF, add *weight profiles* + trigram channel + canonical boost

**Merit:** High. This directly improves “precision + exact token recall,” which you explicitly care about.

Your original plan already had:

* Postgres FTS (`tsvector`) + `pg_trgm`
* semantic pgvector
* fusion (RRF) in application code

✅ **Implement these enhancements (without changing tool schemas):**

* Add configurable **weight profiles** (technical vs conversational vs code) *internally*.
* Add trigram channel results explicitly into fusion.
* Add canonical/pinned boost as a deterministic multiplier or a “virtual-rank” channel.

**For BM25 you’ll want an optional lane** (see section B), but even without BM25, the weight-profile + trigram improvements are worth implementing.

---

### 3) Contextual embeddings for canonical specs/plans (Voyage Contextualized + Jina Late Chunking)

**Merit:** High specifically for “canonical app/feature specs and plans,” because those chunks often contain anaphora and section-local statements that need whole-doc context.

**Voyage:**

* `voyage-context-3` exists specifically for contextualized chunk embeddings; docs describe supported `output_dimension` values. ([Voyage AI][4])
* Voyage API provides a dedicated contextualized embeddings endpoint. ([Voyage AI][5])

**Jina:**

* Jina explicitly documents “late chunking” and that it’s enabled by a `late_chunking` parameter (and is intended to produce contextual chunk embeddings). ([Jina AI][6])

✅ **Implement:**

* Extend your embedder interface with a **contextual document mode**:

  * Voyage: call `/v1/contextualizedembeddings` for *document chunk arrays*
  * Jina: set `late_chunking=true` when embedding a list of chunk texts that belong to the same document (canonical doc version)
* Apply contextual embedding only for canonical doc classes (app_spec, feature_spec, implementation_plan) by reading `memory_items.doc_class` and/or existence in `canonical_docs`.

**Critical integration requirement:**

* **Disable overlap chunking** for contextual embedding modes (Voyage contextualized embeddings are designed around embedding chunks as a coherent set; overlap can distort context windows and cause redundant near-duplicates).

---

### 4) Add MCP Resources (list/read) so memory is browsable as URIs, not only tools

**Merit:** High in practice for Claude Code / Codex TUI style workflows because resources give you:

* “browse memory”
* “open canonical spec section”
* consistent URIs

MCP resources are explicitly part of the MCP server spec. ([Model Context Protocol][7])
The TS SDK supports servers exposing resources. ([GitHub][8])

✅ **Implement:**

* `resources/list`: return pinned canonical docs + recent items
* `resources/read`: allow reading:

  * whole item @ latest
  * whole item @ version
  * section anchor slice (for canonical)

This requires **zero changes** to tool schemas and is additive.

---

### 5) Outbox retry/backoff (production reliability)

**Merit:** High. Your enhanced spec’s worker loop introduces `retry_count` and a max retry threshold — that’s *the right idea*, but the transaction structure they show is unsafe (see section C).

✅ **Implement:**

* Add outbox columns:

  * `retry_count`
  * `next_attempt_at`
  * optionally `locked_at`, `locked_by`
* Update poller to only claim “ready” work.
* Exponential backoff on failures, dead-letter after N attempts.

This is one of the most important production-hardening upgrades you can do.

---

## B) Add / Integrate (lower priority but worthwhile - still implement FULLY if architecture aligns)

### 6) ParadeDB pg_search BM25 (behind a feature flag + capability detection)

**Merit:** Medium–High, but operationally conditional:

* It’s great if you can install it (Neon/Tembo/etc), but many Postgres installs won’t have it.
* Your plan already supports a fallback.

ParadeDB docs show:

* `CREATE INDEX ... USING bm25 (...) WITH (key_field='id')`
* `|||` operator and `pdb.score(id)` for ranking ([ParadeDB][9])
* Note: only one BM25 index per table (important constraint). ([ParadeDB][9])

✅ **Implement if available:**

* On startup (or lazily), detect:

  * extension installed (`pg_extension`)
  * bm25 index exists on `memory_chunks`
* If available, use BM25 results as the lexical channel instead of FTS (or as an additional lexical channel).

**Do not make BM25 mandatory.** Keep FTS+trgm baseline.

---

### 7) Prometheus metrics

**Merit:** Medium. Useful, but adds deployment surface area (HTTP port). I’d treat it as optional and disabled-by-default.

✅ Implement behind `METRICS_PORT` env var, and put metrics mainly on the **worker**, not the STDIO MCP server (which is often run as a local subprocess).

---



## D) Exactly what to implement and how to integrate it *after the original plan is complete*

Below is an “integration checklist” you can apply as a set of post-MVP PRs, in a safe order.

---

# PR 1 — HNSW tuning + dynamic ef_search

### 1. Add provider_config keys (no migration)

In `embedding_profiles.provider_config` store:

```json
{
  "hnsw": { "m": 16, "ef_construction": 64 },
  "query": { "ef_search_min": 40, "ef_search_factor": 2, "ef_search_max": 400 }
}
```

### 2. Modify index creation

Edit: `packages/core/src/vector/indexManager.ts`

* When generating the `CREATE INDEX ... USING hnsw` statement, include:

```sql
WITH (m = <m>, ef_construction = <ef_construction>)
```

Use pgvector defaults if not specified (defaults referenced widely as m=16, ef_construction=64). ([Amazon Web Services, Inc.][1])

### 3. Modify semantic search to set ef_search per query

Edit: `packages/core/src/search/semantic.ts`

* Wrap the semantic query in a transaction on a single client connection:

  * `BEGIN`
  * `SET LOCAL hnsw.ef_search = $1` ([GitHub][2])
  * run vector query
  * `COMMIT`

Compute:

* `k = semantic_top_k`
* `ef_search = clamp(max(40, k, k * factor), min, max)`
  Neon guidance: set `ef_search >= k`. ([Neon][3])

### 4. Add tests

* Integration test asserts:

  * query runs
  * returns >= k candidates when data exists
  * doesn’t pollute pooled connections (important)

---

# PR 2 — Fusion improvements (weight profiles, trigram lane, canonical boost)

Edit:

* `packages/core/src/search/lexical.ts` (ensure trigram lane results are available)
* `packages/core/src/search/fusion.ts`

### Implement

1. Add `inferQueryStyle(query)`:

* if contains stack trace markers, error codes, snake_case/camelCase, lots of punctuation → “code”
* else if many normal words → “conversational”
* else default “technical”

2. Weight profiles (internal config, no schema changes):

```ts
const WEIGHTS = {
  default: { lexical: 0.4, semantic: 0.5, trigram: 0.1 },
  code:    { lexical: 0.3, semantic: 0.3, trigram: 0.4 },
  technical: { lexical: 0.5, semantic: 0.35, trigram: 0.15 },
  conversational: { lexical: 0.25, semantic: 0.7, trigram: 0.05 },
}
```

3. Canonical boost:

* Determine canonical by joining `canonical_docs` or checking `memory_items.canonical_key IS NOT NULL`.
* Apply a deterministic multiplier (e.g. `score *= 1.1`), or an extra “RRF channel” with a small weight.

  * Do **not** require schema changes like `mi.is_canonical`.

### Tests

* Ranking regression tests:

  * exact token query must surface troubleshooting chunk
  * spec query must surface canonical chunk

---

# PR 3 — Contextual embeddings for canonical docs (Voyage + Jina)

## 1. Extend embedder interface

Edit: `packages/clients/src/embedder.ts`

Add:

* `embedDocumentChunksContextual?(chunks: string[]): Promise<number[][]>`

## 2. Voyage contextual endpoint support

Add: `packages/clients/src/voyage.ts`

* implement `/v1/contextualizedembeddings` (Voyage API reference confirms endpoint exists). ([Voyage AI][5])
* Respect model dims supported by voyage-context-3. ([Voyage AI][4])

## 3. Jina late_chunking support

Add: `packages/clients/src/jina.ts`

* When profile_config includes `"late_chunking": true`, send `late_chunking=true` in request.
  Jina documents late chunking as an API parameter and the technique’s purpose. ([Jina AI][6])

## 4. Worker changes

Edit: `packages/worker/src/jobs/embedVersion.ts`

* Determine if the version’s item is canonical:

  * join `memory_versions → memory_items → canonical_docs` (or `canonical_key`)
* If canonical and profile supports contextual:

  * embed all chunks in order as a single “document chunks set”
  * store embeddings per chunk as usual

## 5. Chunking config coupling

Edit chunker config:

* If embedding mode = contextual:

  * overlap = 0
  * optionally smaller target tokens (e.g. 400–600)

## 6. Tests

* Integration test:

  * insert canonical doc
  * ingest chunks
  * embed with contextual fake embedder (deterministic)
  * semantic retrieval hits the right chunk more reliably (your golden test can assert expected chunk ID)

---

# PR 4 — MCP Resources (list/read) for memory browsing

Edit: `packages/mcp-server/src/main.ts` (or add `resources.ts`)

Implement:

* `resources/list` handler returning URIs for:

  * pinned canonical docs
  * last N updated items
* `resources/read` handler supporting:

  * item @ latest
  * item @ version
  * item section anchor (canonical)

Resources are part of the MCP server spec and are read via `resources/read`. ([Model Context Protocol][7])

**No schema/tool changes required.**

---

# PR 5 — Outbox retry/backoff + dead-letter behavior

## 1. DB migration

Add `migrations/0010_outbox_retries.sql`:

* `retry_count int not null default 0`
* `next_attempt_at timestamptz`
* optional `locked_at`, `locked_by`
* index for ready events

## 2. Worker poller update

Edit: `packages/worker/src/outboxPoller.ts`

* Claim events where:

  * `processed_at IS NULL`
  * `(next_attempt_at IS NULL OR next_attempt_at <= now())`
  * `retry_count < MAX_RETRIES`
* On failure:

  * `retry_count += 1`
  * `error = ...`
  * `next_attempt_at = now() + backoff(retry_count)`

## 3. Tests

* Insert failing event, verify retry_count increments and next_attempt_at set
* After MAX retries, verify it stops being picked up (dead-letter)

---

# PR 6 — BM25 (ParadeDB pg_search) lane

Only do this if you can run pg_search.

## 1. Migration (already exists but should be upgraded)

Update `migrations/0090_optional_bm25_pg_search.sql`:

* `CREATE EXTENSION IF NOT EXISTS pg_search;`
* `CREATE INDEX ... USING bm25 (...) WITH (key_field='id')` ([ParadeDB][9])

## 2. Runtime detection

In `packages/core/src/search/lexical.ts`:

* detect if extension installed + bm25 index exists
* if yes, run bm25 queries using:

  * `|||` operator and `pdb.score(id)` ([ParadeDB][10])

## 3. Fusion integration

Treat BM25 output as “lexical lane” input to RRF.

---

## Bottom line recommendations

If you implement only a few of these enhancements, do them in this order:

1. **Dynamic `hnsw.ef_search` + HNSW params in profile config** (huge ROI for retrieval quality/latency control) ([GitHub][2])
2. **Weight-profile fusion + trigram lane + canonical boost** (improves exact token recall and spec recall)
3. **Contextual embeddings for canonical docs** (big quality bump for specs/plans) ([Voyage AI][4])
4. **Outbox retries/backoff** (production reliability)
5. **MCP resources/list+read** (better UX / reuse across sessions) ([Model Context Protocol][7])
6. **BM25 via pg_search** (excellent but optional) ([ParadeDB][9])
7. **Prometheus metrics** (nice-to-have)

References and evidence:

[1]: https://aws.amazon.com/blogs/database/accelerate-hnsw-indexing-and-searching-with-pgvector-on-amazon-aurora-postgresql-compatible-edition-and-amazon-rds-for-postgresql/?utm_source=chatgpt.com "Accelerate HNSW indexing and searching with pgvector on Amazon ..."
[2]: https://github.com/pgvector/pgvector?utm_source=chatgpt.com "pgvector/pgvector: Open-source vector similarity search for ..."
[3]: https://neon.com/docs/ai/ai-vector-search-optimization?utm_source=chatgpt.com "Optimize pgvector search - Neon Docs"
[4]: https://docs.voyageai.com/docs/contextualized-chunk-embeddings?utm_source=chatgpt.com "Contextualized Chunk Embeddings - Introduction - Voyage AI"
[5]: https://docs.voyageai.com/reference/contextualized-embeddings-api "Contextualized chunk embedding models"
[6]: https://jina.ai/embeddings/?utm_source=chatgpt.com "Embedding API"
[7]: https://modelcontextprotocol.io/specification/2025-06-18/server/resources?utm_source=chatgpt.com "Resources"
[8]: https://github.com/modelcontextprotocol/typescript-sdk?utm_source=chatgpt.com "modelcontextprotocol/typescript-sdk"
[9]: https://docs.paradedb.com/documentation/indexing/create-index "Create an Index - ParadeDB"
[10]: https://docs.paradedb.com/documentation/getting-started/quickstart "Quickstart - ParadeDB"
