# Codex Memory Usage Guidelines (Qdrant + Neo4j)

You have access to two long-term memory systems via MCP:

- Semantic memory: Qdrant (MCP server name: `qdrant_memory`)
  - Primary tools: `qdrant-store`, `qdrant-find`
- Graph memory: Neo4j (MCP server name: `neo4j_memory`)
  - Primary tools: `create_entities`, `create_relations`, `add_observations`, `read_graph`, `search_nodes`
  - Exact tool names may vary; infer from the tool list exposed by the MCP server.

Use these memories to persist important information across sessions per project, while keeping different projects fully isolated.

---

## 0. Project Context and Separation

Each coding session is associated with exactly one active project, identified by a `project_id`.

- The user will specify the active project at the beginning of a session
  (e.g. `wekadocs-matrix`, `trader-3s`, `thoughtscope`).
- Treat this as `current_project_id` for the entire session unless the user explicitly switches projects.

### Rules:

- All memory writes MUST use `project_id = current_project_id`.
- All memory reads MUST be scoped to `current_project_id`.
- Do not invent or change `project_id` arbitrarily.
- Do not mix entities or memories across different `project_id` values, unless the user explicitly asks for a cross-project comparison.
- If the user changes projects mid-conversation, treat that as a new project context:
  - Update `current_project_id`.
  - From that point on, restrict memory reads/writes to the new project.

---

## 1. Core Metadata Concepts

For every memory you store (in Qdrant metadata and/or Neo4j properties/observations), treat the following fields as canonical:

- `project_id` - canonical project identifier (e.g. "wekadocs-matrix")
- `environment` - "dev", "prod", "scratch", "demo", etc.
- `memory_type` - one of:
  - "decision", "plan", "task", "summary", "observation",
  - "bug", "experiment", "question", "constraint", "rule".
- `scope` - "project", "feature", "session", or "task".
- `source_client` - "openai-codex" for this client.
- `author_model` - your current model identifier (e.g. "gpt-5.1-codex-high").
- `created_at` - ISO timestamp when you first store the memory.
- `updated_at` - ISO timestamp when you modify an existing memory.
- `tags` - list of short topic tags, e.g. ["graph-rag", "neo4j", "chunking"].

Always set at least:

- `project_id = current_project_id`
- `environment`
- `memory_type`
- `source_client`
- `created_at`

Use the same conceptual fields for:

- Qdrant `metadata` (JSON)
- Neo4j entity properties and/or observation text (e.g. "project_id: wekadocs-matrix")

---

## 2. When to Use Each Memory System

### 2.1 Semantic memory (Qdrant)

Use Qdrant as a semantic recall layer for natural-language queries.

Store in Qdrant (via `qdrant-store`):

- Architectural decisions (summarized)
- Plans and roadmaps (summarized)
- Session summaries
- High-level observations, bug summaries, experiment summaries, constraints, rules
- Important open questions

Retrieve from Qdrant (via `qdrant-find`) to answer questions like:

- "What did we decide about X?"
- "Summarize prior discussions on Y."
- "What constraints or rules exist for this project?"
- "What were the key outcomes of the last few sessions?"

### 2.2 Graph memory (Neo4j)

Use Neo4j as a structured knowledge graph of the project.

Store as Neo4j entities/relations:

- Entities:
  - `Project`, `Decision`, `Plan`, `Task`, `Bug`, `Experiment`, `Summary`, `Constraint`, `Rule`, `Session`, etc.
- Relationships between them:
  - Project <-> Decision
  - Project <-> Plan
  - Plan <-> Task
  - Task <-> Bug or Constraint
  - Decision <-> Experiment
  - Project <-> Session

Retrieve from Neo4j to answer:

- "Which decisions affect this plan?"
- "What tasks belong to this phase or plan?"
- "Show me all open tasks for this project."
- "What sessions have touched HybridRetrieval.py?"

### 2.3 Default write policy

Unless the user explicitly says otherwise:

- For decisions, plans, summaries, constraints, rules - write to both:
  - Qdrant (semantic summary + metadata)
  - Neo4j (structured entity + relationships + observations)
- For tasks and bugs - write to both:
  - Neo4j: strongly typed entities and relations (for structured queries)
  - Qdrant: brief semantic summary (for natural-language recall)
- For low-level observations / logs:
  - Prefer Neo4j observations (attached to existing entities).
  - Use Qdrant only when the observation is semantically valuable as a standalone memory.

When the user says:

- "semantic memory only" - write to Qdrant only.
- "graph memory only" - write to Neo4j only.
- "both semantic and graph memory" - write to both.

---

## 3. Qdrant Memory (Semantic) - Project-Scoped Usage

### 3.1 Project-scoped collections

Use one Qdrant collection per project:

- `collection_name = "<current_project_id>-mem"`
  - Examples:
    - `wekadocs-matrix-mem`
    - `trader-3s-mem`

Rules:

- Every `qdrant-store` and `qdrant-find` call MUST include:
  - `collection_name = "<current_project_id>-mem"`.
- Every stored item MUST include:
  - `metadata.project_id = current_project_id`.

This ensures each project has its own semantic memory namespace, even though all projects share the same Qdrant instance.

### 3.2 Storing memory (qdrant-store)

When calling `qdrant-store`, use:

- `information` - a concise, human-readable text summary.
- `metadata` - JSON including the canonical fields.

Do not put identifiers like `source_client` or timestamps inside `information`. Keep them in `metadata` only.

Information format guidelines:

- Start with 1-2 sentences that summarize the memory.
- Optionally follow with a short bullet list of key points.
- Avoid:
  - Raw logs / stack traces (summarize them)
  - Large code blocks (summarize; the repo is the source of truth)

Example for a decision memory:

```
information:
  We will adopt the Symmetric Hybrid GraphRAG architecture (Strategy #2) as
  the primary retrieval strategy. The graph handles structure and context paths;
  the vector DB handles dense similarity; a fusion layer combines them.

metadata:
{
  "project_id": "wekadocs-matrix",
  "environment": "dev",
  "memory_type": "decision",
  "scope": "project",
  "source_client": "openai-codex",
  "author_model": "gpt-5.1-codex-high",
  "created_at": "<timestamp>",
  "tags": ["graph-rag", "symmetric-hybrid", "architecture"]
}
collection_name: "wekadocs-matrix-mem"
```

### 3.3 Retrieving memory (qdrant-find)

When calling qdrant-find:
- Always query the current project's collection:
  - `collection_name = "<current_project_id>-mem"`.
- Always filter or post-filter results by:
  - `metadata.project_id == current_project_id`
  - and, when appropriate, by environment.

When the user asks about a specific category, bias towards matching memory_type:
- For design decisions - prioritize memory_type = "decision".
- For tasks - prioritize memory_type = "task".
- For summaries - prioritize memory_type = "summary".
- For constraints / rules - prioritize memory_type = "constraint" or "rule".

When answering, explicitly respect existing decisions, rules, and constraints retrieved from Qdrant.

---

## 4. Neo4j Memory (Graph) - Project-Scoped Usage

### 4.1 Project root entity

For each project_id, there SHOULD be a single canonical Project entity in Neo4j, e.g.:
- type: "Project"
- title: human-readable name (e.g. "WekaDocs-Matrix")
- description: short project summary
- Properties / observations including:
  - project_id: "<project_id>"
  - environment: "dev" (or appropriate)
  - created_at, updated_at
  - tags, etc.

All other entities that belong to the same project MUST:
- Include project_id: "<current_project_id>".
- Be connected (directly or indirectly) to this Project entity via project-scoped relationships such as:
  - [:BELONGS_TO_PROJECT]
  - [:HAS_PLAN], [:HAS_DECISION], [:HAS_TASK], [:HAS_SUMMARY], etc.

### 4.2 Entities

When using Neo4j memory tools (e.g. create_entities), create entities with conceptual fields:
- type:
  - "Project", "Decision", "Plan", "Task", "Bug", "Experiment", "Summary", "Constraint", "Rule", "Session", etc.
- title: short human-readable title.
- description: concise explanation or summary.
- Common metadata:
  - project_id = current_project_id
  - environment
  - memory_type
  - scope
  - source_client
  - author_model
  - created_at
  - updated_at
  - tags

Examples:
- type: "Decision" -> memory_type: "decision"
- type: "Plan" -> memory_type: "plan"
- type: "Task" -> memory_type: "task"
- type: "Bug" -> memory_type: "bug"
- type: "Experiment" -> memory_type: "experiment"
- type: "Constraint" -> memory_type: "constraint"
- type: "Rule" -> memory_type: "rule"
- type: "Session" -> memory_type: "summary" or "observation" (session-level)

### 4.3 Relationships

When creating relations (e.g. via create_relations), use stable, descriptive relationship types. Example patterns:
- Project-scoped:
  - (:Project)-[:HAS_DECISION]->(:Decision)
  - (:Project)-[:HAS_PLAN]->(:Plan)
  - (:Project)-[:HAS_SUMMARY]->(:Summary)
  - (:Entity)-[:BELONGS_TO_PROJECT]->(:Project) (generic linkage)
- Plan / Task / Bug:
  - (:Plan)-[:HAS_TASK]->(:Task)
  - (:Task)-[:BLOCKED_BY]->(:Bug)
- Decisions and Experiments:
  - (:Decision)-[:INFLUENCES]->(:Plan)
  - (:Experiment)-[:VALIDATES]->(:Decision)
- Sessions:
  - (:Session)-[:SESSION_FOR_PROJECT]->(:Project)
  - (:Session)-[:SESSION_TOUCHES_TASK]->(:Task)
  - (:Session)-[:SESSION_TOUCHES_PLAN]->(:Plan)

Separation rule:
- Entities involved in a relation MUST share the same project_id and compatible environment.
- Never create relationships between entities with different project_id values, unless:
  - The user explicitly requests a cross-project comparison, and
  - You clearly document this in observations (e.g. "cross_project_link: true").

### 4.4 Observations

For incremental updates (progress, results, notes), use observation tools (e.g. add_observations) to attach time-stamped text to existing entities.

Use observations for:
- Experiment runs and metrics.
- Status updates on tasks (todo -> in-progress -> done).
- Clarifications or refinements of decisions, plans, or constraints.
- Session notes attached to Session entities.

Prefer updating existing entities via observations over creating new entities whenever you are updating a known decision, plan, task, bug, or experiment.

---

## 5. Natural-Language Triggers (User Phrases -> Actions)

Interpret user phrases as follows.

### 5.1 Memory type triggers
- "store this as a decision memory"
  - memory_type = "decision"
  - Create/Update a Decision entity in Neo4j and store a semantic summary in Qdrant.
- "store this as a plan memory"
  - memory_type = "plan"
  - Create/Update a Plan entity in Neo4j and store a summary in Qdrant.
- "store this as a task / todo memory"
  - memory_type = "task"
  - Create/Update a Task entity in Neo4j (linked to Project/Plan) and store a brief summary in Qdrant.
- "create a session summary memory", "summary memory"
  - memory_type = "summary"
  - Create/Update a Session or Summary entity in Neo4j and store a semantic session summary in Qdrant.
- "log this as an observation memory", "note memory"
  - memory_type = "observation"
  - Prefer Neo4j observations on existing entities; optionally store a semantic snippet in Qdrant if helpful.
- "store this as a bug / incident memory"
  - memory_type = "bug"
  - Create/Update a Bug entity in Neo4j and a bug summary in Qdrant.
- "store this as an experiment memory"
  - memory_type = "experiment"
  - Create an Experiment entity in Neo4j; use observations for runs/results; store a high-level summary in Qdrant.
- "record this as an open question / question memory"
  - memory_type = "question"
  - Store the question in Qdrant; optionally create a Question entity in Neo4j.
- "store this as a constraint / rule memory"
  - memory_type = "constraint" or "rule"
  - Create/Update a Constraint or Rule entity in Neo4j and store a summary in Qdrant.

### 5.2 Store-location triggers
- "in both semantic memory and graph memory"
  - Write to Qdrant and Neo4j.
- "semantic memory only"
  - Write only to Qdrant.
- "graph memory only"
  - Write only to Neo4j.

### 5.3 Linking and updating

When the user says:
- "link this to the existing <X>"
  - In Neo4j:
    - Find the relevant entity by project_id, type, and title/description.
    - Create an appropriate relationship (e.g. [:HAS_TASK], [:INFLUENCES], [:BLOCKED_BY]).
- "update that decision / plan / task / bug"
  - In Neo4j:
    - Find the corresponding entity.
    - Add an observation describing the update and/or update its properties (description, updated_at, tags, status).
  - In Qdrant:
    - Optionally store a new summary reflecting the updated state.

---

## 6. What NOT to Store

Do not store:
- Low-value or highly ephemeral content:
  - One-off scratch calculations
  - Temporary debug prints
  - Non-actionable, transient thoughts
- Large raw logs or stack traces:
  - Summarize them (key errors, root cause, fix) instead.
- Full code files or large code blocks:
  - Store concise summaries, decisions, or "recipes".
  - The repository, RAG, or file tools are the source of truth for actual code.

Focus memory on:
- Decisions and trade-offs
- Plans and roadmaps
- Constraints and rules
- Important bugs and experiments
- Stable summaries and high-value observations
- Well-structured tasks and progress

Always:
- Respect and reuse existing memory instead of inventing conflicting information.
- Respect project boundaries:
  - Never mix or relate memories across project_ids unless explicitly requested for cross-project analysis.
