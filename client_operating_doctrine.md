Yes — you’re missing a critical piece: **client-side operational guidance** that teaches the LLM *how to use the memory tools* (when, why, and with what payloads) in a consistent, deterministic way.

There are **three complementary places** to put these instructions so the MCP client (Claude Code / Codex TUI) actually behaves the way you want:

1. **Tool descriptions** (returned by MCP `tools/list`)

   * Short, high-signal “toolcards” embedded into each tool’s description field.
   * These are always visible to the model when it is deciding which tool to call.

2. **MCP prompts** (returned by `prompts/list` / `prompts/get`)

   * Longer “operating manual” prompts the client can insert into context (manually or automatically).
   * Best for comprehensive policies, templates, and workflow playbooks.

3. **A client “system instructions” snippet** (pasted into your agent’s global/project instructions)

   * Ensures the model starts every session with the same operating loop even if prompt retrieval isn’t automatic.

Below is a complete **Client Instruction Pack** you can use as:

* a “system prompt” for the coding agent **and/or**
* MCP prompt bodies **and/or**
* source text for tool descriptions.

---

# A. Client System Instruction Snippet (paste into the agent’s instructions)

Use this as the **default memory policy** for the LLM client (Claude Code / Codex). This is intentionally strict and explicit.

```text
You have access to the Memento MCP Memory Server which provides durable project memory. Use it proactively to persist specs, plans, troubleshooting learnings, runbooks, and environment facts across sessions.

Operating principles:
1) Never store secrets (API keys, passwords, private tokens, private keys). Redact them before committing. If unsure, do not store.
2) Memory is project-scoped by default. Do not mix projects. Always ensure an active project is set via projects.resolve before using any other tool.
3) Writes must be idempotent and atomic. For any write tool that requires idempotency_key, generate a stable idempotency_key and reuse it if retrying the same write.
4) Canonical docs are authoritative and should be pinned by default (app spec, feature specs, implementation plan). Use canonical.* tools for these.
5) Everything else (notes, troubleshooting, runbooks, environment facts, session snapshots) uses memory.* tools unless it is “canonical and enduring”.
6) At the start of a session: restore context deterministically. At the end: write a session snapshot and commit key learnings.

Session start protocol (do this once per session):
A) Call projects.resolve with cwd and/or repo_url and create_if_missing=true.
B) Call sessions.start (record client_name).
C) Call memory.restore with the user’s stated goal (or omit goal if unknown). Read/expand any returned URIs as needed using memory.get or canonical.get_section.

Session end protocol (do this near the end or when user requests):
A) If there were meaningful changes/decisions: create a session snapshot using sessions.end with create_snapshot=true and include a structured summary.
B) Commit any new durable knowledge (troubleshooting learnings, runbooks, environment facts) using memory.commit.
C) Link related items (runbook ↔ troubleshooting ↔ spec/plan) using memory.link.

Tool selection decision rule:
- If the user is defining/updating an authoritative spec/plan that will be referenced repeatedly → use canonical.upsert.
- If the user is recording an incident/lesson/runbook/how-to → use memory.commit (kind=troubleshooting/runbook/environment_fact).
- If the user is asking “what do we know about X” → use memory.search then memory.get/canonical.get_section as needed.
- If the user is asking “what changed” → use memory.history and/or memory.diff.
- If the user wants a deterministic bootstrap of current project context → use memory.restore (optionally with goal).
- Only use embedding_profiles.* if the user explicitly requests changing the embedding provider/model.

Content quality rules (for anything you store):
- Write in a structured template (symptoms → cause → fix → prevention).
- Include concrete commands, file paths, service names, environment names, and “verified” vs “hypothesis”.
- Add tags for future retrieval (service name, environment, feature name, error code).
- Store minimal but sufficient detail; avoid huge logs unless necessary—prefer short excerpts and a summary.
```

---

# B. Tool-by-tool “Toolcards” (what the MCP client should know)

These are written so you can use them in **tool descriptions** (shortened as needed) *and/or* as internal client guidance.

## 1) `projects.resolve`

**When to use**

* First tool call of every session (mandatory).
* Whenever switching repos/projects.
* Before any other memory tool call if active project is unknown.

**What it does**

* Resolves/creates workspace + project and sets active project context.

**Required inputs (recommended)**

* `cwd` and/or `repo_url`
* `workspace_name` (or let default)
* `create_if_missing=true`

**Follow-up**

* Call `sessions.start`
* Then `memory.restore`

---

## 2) `sessions.start`

**When to use**

* Immediately after `projects.resolve`.

**What it does**

* Creates an audit record of the current interactive session.

**Follow-up**

* Use returned `session_id` as metadata in subsequent commits (optional but recommended).

---

## 3) `sessions.end`

**When to use**

* When the user says: “wrap up”, “summarize”, “save state”, “end session”
* Or when you’re about to stop working and want a reliable handoff.

**Best practice**

* `create_snapshot=true` most of the time.
* Snapshot content should be a structured, concise but complete “state of work”.

**Snapshot template (recommended)**

* What we set out to do
* What we changed (files/behavior)
* Decisions made (with rationale)
* Open questions / TODOs
* Known issues / next steps

---

## 4) `canonical.upsert`

**When to use**

* User is creating/updating **canonical** artifacts:

  * App spec
  * Feature spec(s)
  * Implementation plan
  * Official runbook that is “the one true runbook”

**What it does**

* Upserts a canonical doc by `canonical_key` (stable identifier)
* Pins by default
* Creates a new version
* Enqueues ingestion + embedding

**How to choose `canonical_key` (rules)**

* App spec: `app`
* Feature specs: `feature/<name>` (e.g., `feature/auth`, `feature/payments`)
* Plans: `plan/<topic>` or `plan/main`
* Runbooks: `runbook/<service>/<task>`
* Environment registry: `env/registry`

**Follow-up**

* If you need a section: call `canonical.outline` then `canonical.get_section`
* If you need goal-driven excerpt pack: `canonical.context_pack`

---

## 5) `canonical.get`

**When to use**

* You know the canonical key and want the doc (latest or specific version).

**Follow-up**

* If doc is too large, call `canonical.outline` and `canonical.get_section`.

---

## 6) `canonical.outline`

**When to use**

* You need precise section targeting (best for low-latency, high-precision recall).
* You want a “table of contents” for a canonical spec.

**Follow-up**

* `canonical.get_section` with `section_anchor`.

---

## 7) `canonical.get_section`

**When to use**

* You want deterministic retrieval of an exact section without running search.
* You already know the `section_anchor`.

**This is your “precision scalpel.”**
Use it instead of copying whole docs into context.

---

## 8) `canonical.context_pack`

**When to use**

* You have a goal and want the best subset of the canonical doc for that goal.
* Use when you want higher recall than a single section but still keep context small.

---

## 9) `memory.commit`

**When to use**

* Persist non-canonical knowledge:

  * troubleshooting learnings
  * environment facts
  * runbooks (unless you want them canonical)
  * decisions
  * notes/snippets
  * session “what we learned” entries

**Golden rule**

* Use `memory.commit` for “durable knowledge that will help later.”

**Make commits searchable**

* Use good titles
* Add tags (service/env/error-code/feature)
* Use structured templates

**Idempotency**

* Generate and reuse `idempotency_key` for the same intended commit.

---

## 10) `memory.search`

**When to use**

* User asks:

  * “What do we know about…”
  * “Have we seen this error before…”
  * “Where is service X deployed…”
  * “What was the plan for Y…”

**How to use well**

* Use filters aggressively:

  * if asking about a runbook → `filters.kinds=["runbook"]`
  * troubleshooting error codes → `filters.kinds=["troubleshooting"]`
  * spec questions → `filters.canonical_only=true` and/or doc_class filter

**Follow-up**

* For a hit: call `memory.get` (or `canonical.get_section` if canonical + anchor available)

---

## 11) `memory.get`

**When to use**

* You have an `item_id` or `canonical_key` and need content.
* Use `max_chars` to control size.

---

## 12) `memory.restore`

**When to use**

* Start of every session
* Any time you need to “rebuild context” deterministically

**Best practice**

* Include `goal` if the user has one.
* If `include_context_pack=true`, use it to bootstrap your working context.

---

## 13) `memory.history`

**When to use**

* User asks: “what versions exist?” or “what changed over time?”

---

## 14) `memory.diff`

**When to use**

* User asks: “show me what changed between version X and Y”
* Useful for specs and plans evolution.

---

## 15) `memory.pin` / `memory.unpin`

**When to use**

* Pin “always needed” docs:

  * app spec
  * main plan
  * critical runbooks
  * environment registry

Pinned items are prioritized by `memory.restore`.

---

## 16) `memory.link`

**When to use**

* Create relationships:

  * troubleshooting entry → runbook
  * runbook → service spec
  * decision → spec section
  * plan → feature spec

Links improve restore and future navigation.

---

## 17) `memory.archive`

**When to use**

* Item is obsolete and should not appear by default.

---

## 18) `embedding_profiles.list/upsert/activate`

**When to use**

* Only if user explicitly requests:

  * “Switch to Jina embeddings”
  * “Try Voyage with smaller dims”
  * “Use my local OpenAI-compatible embedder”

Otherwise leave profiles alone (use the project default).

---

## 19) `admin.reingest_version` / `admin.reindex_profile`

**When to use**

* Indexing got out of sync:

  * missing chunks
  * embeddings absent
  * profile changed and needs rebuild

Usually this is rare and manual.

---

## 20) `health.check`

**When to use**

* User reports “memory isn’t working”
* Before diagnosing indexing issues
* To check worker backlog

---

# C. Deterministic Idempotency Key Rules (so retries don’t duplicate)

This is one of the biggest failure modes in practice, so be explicit.

## For single-document writes (`canonical.upsert`, `memory.pin`, etc.)

Use a deterministic key:

* `"{tool}:{canonical_key}:{sha256(content_text)}"`

Example:

* `canonical.upsert:feature/auth:8f2c...`

## For batch commits (`memory.commit`)

Compute a stable digest of the entire batch:

* Normalize each entry to:

  * `(canonical_key or title) + checksum(content_text)`
* Concatenate in a stable order
* `idempotency_key = "memory.commit:{sha256(concat)}"`

**If the client can’t compute SHA easily**
Use a UUID, but store it in session state and reuse it on retry.

---

# D. Content Templates (what to store for precision + reuse)

These templates are designed to maximize:

* sparse keyword recall (error codes, service names, commands)
* semantic recall (explanatory narrative)
* deterministic section addressing (for canonical docs)

## 1) Troubleshooting entry (kind=`troubleshooting`)

**Title**
`[Service] [Env] — Symptom/Error — Root Cause Summary`

**Body**

* **Symptoms**

  * exact error strings / codes
  * logs excerpt (short)
* **Impact**
* **Environment**

  * env name, cluster, region
* **Root cause**

  * verified facts vs hypotheses
* **Fix**

  * exact commands / config changes
* **Verification**

  * how to confirm fixed
* **Prevention**
* **Links**

  * PR/commit, runbook, spec section

**Tags**
`["service:<name>", "env:<name>", "error:<code>", "component:<x>"]`

---

## 2) Environment fact (kind=`environment_fact`)

**Title**
`[Service/System] — Where it lives / How to access`

**Body**

* **What**
* **Where**

  * URLs, clusters, namespaces (no secrets)
* **How**

  * step-by-step commands
* **Ownership**

  * team/contact
* **Gotchas**
* **Related runbooks**

---

## 3) Runbook (kind=`runbook`)

**Title**
`Runbook — [Service] — [Task]`

**Body**

* Preconditions
* Steps
* Rollback
* Verification
* Escalation
* Known failure modes + troubleshooting links

---

## 4) Decision record (kind=`decision`)

**Title**
`Decision — [Topic] — [Chosen Option]`

**Body**

* Context
* Options considered
* Decision
* Rationale
* Consequences
* Follow-ups
* Links to specs/plans

---

## 5) Canonical app spec / feature spec / implementation plan

These should be **canonical docs** (`canonical.upsert`) so they’re versioned and pinned.

Use stable headings so anchors remain stable across revisions:

* `#` Document name
* `## Overview`
* `## Requirements`
* `## Non-goals`
* `## Architecture`
* `## Data model`
* `## API`
* `## Operational considerations`
* `## Rollout plan`
* `## Open questions`

---

# E. Workflow Playbooks (exact sequences of tool calls)

## Playbook 1: Start a work session

1. `projects.resolve` (cwd + repo_url)
2. `sessions.start`
3. `memory.restore` with `goal` if known
4. If restore returns canonical docs:

   * `canonical.outline` or `canonical.get_section` for the relevant section(s)

## Playbook 2: User asks “Save this as the app spec”

1. `canonical.upsert` with:

   * `canonical_key="app"`
   * `doc_class="app_spec"`
   * content markdown
2. Optionally:

   * `canonical.outline` to confirm anchor structure

## Playbook 3: User asks “What do we know about ECONNRESET?”

1. `memory.search` with:

   * `query="ECONNRESET"`
   * `filters.kinds=["troubleshooting"]`
2. `memory.get` for top hits (or `max_chars` small first)
3. If needed: commit improved consolidated troubleshooting entry via `memory.commit`.

## Playbook 4: End session with durable handoff

1. `sessions.end` with `create_snapshot=true` and structured summary
2. `memory.commit` for any new durable learnings
3. `memory.link` to connect new troubleshooting → runbook/spec

---

# F. MCP Prompts you should add to the server (so clients can pull them on demand)

Even if a client doesn’t automatically use prompts, having them available is valuable:

* users can type “load the Memento operating manual prompt”
* or the client can be configured to pull it once per session

## Prompt definitions (names + exact bodies)

### 1) `memento/operating-manual`

(Use the “Client System Instruction Snippet” from section A verbatim.)

### 2) `memento/session-start`

```text
Session start protocol:
1) Call projects.resolve (cwd + repo_url if available).
2) Call sessions.start.
3) Call memory.restore with the user’s current goal (if stated).
4) Expand only the minimum required context:
   - If canonical docs are relevant, call canonical.outline and canonical.get_section for precise sections.
   - Otherwise use memory.search and memory.get.
Do not pull entire documents unless necessary. Prefer section anchors and excerpts.
```

### 3) `memento/session-end`

```text
Session end protocol:
1) Produce a structured “session snapshot” (what changed, decisions, TODOs, risks).
2) Call sessions.end with create_snapshot=true and avoid secrets.
3) Commit new durable learnings (troubleshooting/runbooks/environment facts) via memory.commit.
4) Link new items to relevant canonical docs or runbooks via memory.link.
```

### 4) `memento/troubleshooting-template`

(Use the troubleshooting template from section D.)

### 5) `memento/runbook-template`

(Use the runbook template from section D.)

### 6) `memento/canonical-spec-template`

(Use the canonical structure from section D.)

---

# G. One additional implementation prompt for your *agentic coder* (to add to the build plan)

If you want the coder implementing the server to bake this into the MCP interface, give them this:

```text
Add comprehensive tool descriptions and MCP prompts.

Deliverables:
1) For every MCP tool, include a human-readable description that:
   - says when to use it
   - key inputs
   - idempotency/retry notes for write tools
   - common follow-ups (e.g., search -> get)
2) Implement MCP prompts:
   - memento/operating-manual
   - memento/session-start
   - memento/session-end
   - memento/troubleshooting-template
   - memento/runbook-template
   - memento/canonical-spec-template

Acceptance criteria:
- tools/list clearly teaches the model tool choice without external docs
- prompts/list + prompts/get return the above prompts verbatim
```

---

## Bottom line

You’re not missing *more tools* — you’re missing a **client operating doctrine**. The pack above gives you:

* deterministic session lifecycle behavior
* consistent tool selection
* high-quality stored content (templates + tags)
* reliable retries (idempotency rules)
* precision retrieval habits (outline/get_section first)

If you want, I can also provide **per-tool “example JSON calls”** (exact payload examples matching your Zod schemas) for every tool, including recommended filters and idempotency key formats, so an agent can copy/paste tool calls mechanically without improvisation.
