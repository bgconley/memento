import { ToolSchemas } from "@memento/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; // adjust import to your SDK version
import type { ToolHandlers } from "./toolHandlers";

// Toolcards for MCP tools/list.
//
// Intent: keep these short (tools/list is injected early).
// Put verbose playbooks/templates in MCP prompts (memento/*) and reference them here.
//
// Global norms (do not repeat everywhere to save tokens):
// - If missing project context: call projects.resolve first.
// - Reuse the same idempotency_key when retrying the same write.
const TOOL_DESCRIPTIONS: Record<string, string> = {
  "projects.resolve":
    `Establish/set active workspace+project context (call first each session). Use when starting, switching repos, or if any tool says "missing project context".
Inputs: workspace_name/id, repo_url or project_key preferred for stable restores; cwd is hashed and may differ across machines/paths. Use create_if_missing=true only when creating a new project.
Output: workspace_id, project_id, project_key.
Next: sessions.start -> memory.restore. More: prompt memento/operating-manual.`,

  "projects.list":
    `List projects in a workspace (discovery/admin). Use to find project_id/project_key or confirm what's stored.
Inputs: workspace_name/id, limit/offset, include_archived.
Next: projects.resolve to activate a project. More: prompt memento/operating-manual.`,

  "sessions.start":
    `Start an audited session for the active project (recommended after projects.resolve).
Inputs: client_name, optional metadata (goal/branch/ticket).
Output: session_id.
Next: memory.restore. Use session_id for later commits/snapshots. More: prompt memento/operating-manual.`,

  "sessions.end":
    `End a session; optionally create a durable session snapshot (recommended).
If create_snapshot=true: idempotency_key REQUIRED; snapshot should include goal, changes, decisions, current state, next steps, risks, references.
Next: memory.commit for durable learnings; memory.link to connect artifacts. Template: prompt memento/template-session-snapshot.`,

  "embedding_profiles.list":
    `List embedding profiles (provider/model/dims) for the active project. Use only for configuration/debug.
Next: none (normal usage: don't change profiles unless user asks). More: prompt memento/operating-manual.`,

  "embedding_profiles.upsert":
    `Create/update an embedding profile (voyage|jina|openai_compat) and ensure pgvector index exists.
Requires: idempotency_key. Inputs: name, provider, model, dims, distance, provider_config.
Notes: dims must match embedder output. After switching models, run admin.reindex_profile to backfill. More: prompt memento/operating-manual.`,

  "embedding_profiles.activate":
    `Set the active embedding profile for semantic search (only switch if user requests). Requires idempotency_key.
After activating a new model, you likely need admin.reindex_profile to regenerate embeddings. More: prompt memento/operating-manual.`,

  "memory.commit":
    `Atomic, idempotent batch write for durable NON-canonical knowledge (versioned; triggers indexing). Requires idempotency_key.
Use for: ADRs, notes, spikes, troubleshooting, postmortems, environment facts, code maps, non-canonical runbooks.
Set kind + doc_class using the taxonomy (prompt memento/doc-class-taxonomy). Prefer canonical.upsert for authoritative specs/plans. More: prompt memento/operating-manual.`,

  "memory.get":
    `Fetch an item by item_id OR canonical_key (provide exactly one). Optional version_num; use max_chars to limit size.
Use after memory.search or when you know the identifier. More: prompt memento/operating-manual.`,

  "memory.search":
    `Hybrid search across project memory ("what do we know about X?"). Use filters to increase precision (kinds/scopes/tags/pinned_only/canonical_only/doc_classes).
Next: memory.get or (if canonical) canonical.outline -> canonical.get_section. More: prompt memento/operating-manual.`,

  "memory.restore":
    `Deterministic session bootstrap bundle (no model calls). Use at session start or "restore context".
Inputs: optional goal; include_canonical/latest_snapshot/recent_troubleshooting; include_context_pack to get excerpts under max_chars.
Next: fetch specifics via memory.get or canonical.get_section. More: prompt memento/operating-manual.`,

  "memory.history":
    `List versions for an item (audit). Provide item_id OR canonical_key. Use to answer "when did this change?" or to pick versions for memory.diff.
More: prompt memento/operating-manual.`,

  "memory.diff":
    `Unified diff between two versions of an item (audit). Provide item_id OR canonical_key plus from_version_num/to_version_num.
More: prompt memento/operating-manual.`,

  "memory.pin":
    `Pin an item so it appears in restore by default. Provide item_id OR canonical_key. Requires idempotency_key.
Use for app spec, main plans, env registry, critical runbooks. More: prompt memento/operating-manual.`,

  "memory.unpin":
    `Unpin an item (stop prioritizing in restore). Provide item_id OR canonical_key. Requires idempotency_key.
More: prompt memento/operating-manual.`,

  "memory.archive":
    `Archive or delete an item (soft remove). Provide item_id OR canonical_key. Requires idempotency_key.
Use when doc is obsolete/superseded. More: prompt memento/operating-manual.`,

  "memory.link":
    `Create a typed relationship between items (spec<->design<->plan<->test<->rollout<->runbook<->troubleshooting<->ADR). Requires idempotency_key.
Provide from/to using item_id OR canonical_key; choose relation (depends_on/implements/references/mitigates/etc.). More: prompt memento/playbook-feature-lifecycle.`,

  "canonical.upsert":
    `Create/update an authoritative canonical doc addressed by canonical_key (pinned by default). Requires idempotency_key.
Use doc_class taxonomy (prompt memento/doc-class-taxonomy) and canonical_key conventions. After storing: canonical.outline -> canonical.get_section; memory.link to connect lifecycle artifacts. More: prompt memento/playbook-feature-lifecycle.`,

  "canonical.upsert_file":
    `Create/update a canonical doc by reading content from a local file path (best for large docs). Requires idempotency_key.
Inputs: canonical_key, doc_class, title, path, optional format/tags/metadata/pinned. Server reads the file and stores it as content_text.
Use when content is large to avoid client-side payload overhead. More: prompt memento/playbook-feature-lifecycle.`,

  "canonical.get":
    `Fetch a canonical doc by canonical_key (latest or specific version). Use max_chars to avoid large payloads.
Prefer canonical.outline -> canonical.get_section for precise retrieval. More: prompt memento/operating-manual.`,

  "canonical.outline":
    `List section anchors/heading paths for a canonical doc (precision navigation). Use before canonical.get_section.
More: prompt memento/operating-manual.`,

  "canonical.get_section":
    `Deterministically fetch one canonical section by section_anchor (from canonical.outline). Use max_chars to cap size.
More: prompt memento/operating-manual.`,

  "canonical.context_pack":
    `Goal-driven excerpt pack from within a single canonical doc under max_chars. Use when you need more than one section but less than whole doc.
Next: canonical.get_section for any excerpt that needs full text. More: prompt memento/operating-manual.`,

  "admin.reindex_profile":
    `Maintenance: re-embed/reindex all chunks for an embedding profile (can be expensive). Requires idempotency_key.
Use after switching embedding model/dims or if embeddings are missing/out-of-sync. Prefer mode="enqueue". More: prompt memento/operating-manual.`,

  "admin.reingest_version":
    `Maintenance: re-run chunking/tsvector for a version (and optionally re-embed). Requires idempotency_key.
Use if ingestion failed or chunking rules changed. More: prompt memento/operating-manual.`,

  "health.check":
    `Diagnostic health check: DB connectivity, outbox backlog, active embedding profile, server time. Use when memory seems broken or to monitor reindex/reingest.
More: prompt memento/operating-manual.`,
};

const TOOL_NAME_STYLE = process.env.MEMENTO_TOOL_NAME_STYLE ?? "dot";
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolName(name: string): string {
  if (TOOL_NAME_STYLE === "dot") return name;
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return TOOL_NAME_PATTERN.test(sanitized) ? sanitized : sanitized.replace(/_+/g, "_");
}

function rewriteDescription(raw: string): string {
  if (TOOL_NAME_STYLE === "dot") return raw;
  let rewritten = raw;
  for (const toolName of Object.keys(TOOL_DESCRIPTIONS)) {
    const safeName = sanitizeToolName(toolName);
    rewritten = rewritten.replaceAll(toolName, safeName);
  }
  return rewritten;
}

function registerTool(
  server: McpServer,
  name: keyof typeof ToolSchemas,
  config: {
    inputSchema?: unknown;
    outputSchema?: unknown;
    title?: string;
    description?: string;
    annotations?: unknown;
    _meta?: Record<string, unknown>;
  },
  handler: ToolHandlers[keyof ToolHandlers]
) {
  const toolName = sanitizeToolName(name);
  const toolConfig = {
    ...config,
    description: rewriteDescription(TOOL_DESCRIPTIONS[name] ?? "Memento tool"),
    _meta:
      TOOL_NAME_STYLE === "dot"
        ? config._meta
        : { ...(config._meta ?? {}), memento_raw_name: name },
  };
  server.registerTool(toolName, toolConfig as any, handler as any);
}

/**
 * Registers every tool with an explicit Zod input schema.
 *
 * IMPORTANT:
 * - This is "low-level MCP SDK" style (no FastMCP).
 * - The exact import path/types depend on the MCP SDK version you pin.
 * - The pattern is stable: server.tool(name, schema, handler).
 */
export function registerTools(server: McpServer, handlers: ToolHandlers) {
  // Projects
  registerTool(server, "projects.resolve", {
    inputSchema: ToolSchemas["projects.resolve"].input,
    outputSchema: ToolSchemas["projects.resolve"].output,
  }, handlers.projectsResolve);
  registerTool(server, "projects.list", {
    inputSchema: ToolSchemas["projects.list"].input,
    outputSchema: ToolSchemas["projects.list"].output,
  }, handlers.projectsList);

  // Sessions
  registerTool(server, "sessions.start", {
    inputSchema: ToolSchemas["sessions.start"].input,
    outputSchema: ToolSchemas["sessions.start"].output,
  }, handlers.sessionsStart);
  registerTool(server, "sessions.end", {
    inputSchema: ToolSchemas["sessions.end"].input,
    outputSchema: ToolSchemas["sessions.end"].output,
  }, handlers.sessionsEnd);

  // Embedding profiles
  registerTool(server, "embedding_profiles.list", {
    inputSchema: ToolSchemas["embedding_profiles.list"].input,
    outputSchema: ToolSchemas["embedding_profiles.list"].output,
  }, handlers.embeddingProfilesList);
  registerTool(server, "embedding_profiles.upsert", {
    inputSchema: ToolSchemas["embedding_profiles.upsert"].input,
    outputSchema: ToolSchemas["embedding_profiles.upsert"].output,
  }, handlers.embeddingProfilesUpsert);
  registerTool(server, "embedding_profiles.activate", {
    inputSchema: ToolSchemas["embedding_profiles.activate"].input,
    outputSchema: ToolSchemas["embedding_profiles.activate"].output,
  }, handlers.embeddingProfilesActivate);

  // Memory
  registerTool(server, "memory.commit", {
    inputSchema: ToolSchemas["memory.commit"].input,
    outputSchema: ToolSchemas["memory.commit"].output,
  }, handlers.memoryCommit);
  registerTool(server, "memory.get", {
    inputSchema: ToolSchemas["memory.get"].input,
    outputSchema: ToolSchemas["memory.get"].output,
  }, handlers.memoryGet);
  registerTool(server, "memory.search", {
    inputSchema: ToolSchemas["memory.search"].input,
    outputSchema: ToolSchemas["memory.search"].output,
  }, handlers.memorySearch);
  registerTool(server, "memory.restore", {
    inputSchema: ToolSchemas["memory.restore"].input,
    outputSchema: ToolSchemas["memory.restore"].output,
  }, handlers.memoryRestore);
  registerTool(server, "memory.history", {
    inputSchema: ToolSchemas["memory.history"].input,
    outputSchema: ToolSchemas["memory.history"].output,
  }, handlers.memoryHistory);
  registerTool(server, "memory.diff", {
    inputSchema: ToolSchemas["memory.diff"].input,
    outputSchema: ToolSchemas["memory.diff"].output,
  }, handlers.memoryDiff);
  registerTool(server, "memory.pin", {
    inputSchema: ToolSchemas["memory.pin"].input,
    outputSchema: ToolSchemas["memory.pin"].output,
  }, handlers.memoryPin);
  registerTool(server, "memory.unpin", {
    inputSchema: ToolSchemas["memory.unpin"].input,
    outputSchema: ToolSchemas["memory.unpin"].output,
  }, handlers.memoryUnpin);
  registerTool(server, "memory.link", {
    inputSchema: ToolSchemas["memory.link"].input,
    outputSchema: ToolSchemas["memory.link"].output,
  }, handlers.memoryLink);
  registerTool(server, "memory.archive", {
    inputSchema: ToolSchemas["memory.archive"].input,
    outputSchema: ToolSchemas["memory.archive"].output,
  }, handlers.memoryArchive);

  // Canonical
  registerTool(server, "canonical.upsert", {
    inputSchema: ToolSchemas["canonical.upsert"].input,
    outputSchema: ToolSchemas["canonical.upsert"].output,
  }, handlers.canonicalUpsert);
  registerTool(server, "canonical.upsert_file", {
    inputSchema: ToolSchemas["canonical.upsert_file"].input,
    outputSchema: ToolSchemas["canonical.upsert_file"].output,
  }, handlers.canonicalUpsertFile);
  registerTool(server, "canonical.get", {
    inputSchema: ToolSchemas["canonical.get"].input,
    outputSchema: ToolSchemas["canonical.get"].output,
  }, handlers.canonicalGet);
  registerTool(server, "canonical.outline", {
    inputSchema: ToolSchemas["canonical.outline"].input,
    outputSchema: ToolSchemas["canonical.outline"].output,
  }, handlers.canonicalOutline);
  registerTool(server, "canonical.get_section", {
    inputSchema: ToolSchemas["canonical.get_section"].input,
    outputSchema: ToolSchemas["canonical.get_section"].output,
  }, handlers.canonicalGetSection);
  registerTool(server, "canonical.context_pack", {
    inputSchema: ToolSchemas["canonical.context_pack"].input,
    outputSchema: ToolSchemas["canonical.context_pack"].output,
  }, handlers.canonicalContextPack);

  // Admin + Health
  registerTool(server, "admin.reindex_profile", {
    inputSchema: ToolSchemas["admin.reindex_profile"].input,
    outputSchema: ToolSchemas["admin.reindex_profile"].output,
  }, handlers.adminReindexProfile);
  registerTool(server, "admin.reingest_version", {
    inputSchema: ToolSchemas["admin.reingest_version"].input,
    outputSchema: ToolSchemas["admin.reingest_version"].output,
  }, handlers.adminReingestVersion);
  registerTool(server, "health.check", {
    inputSchema: ToolSchemas["health.check"].input,
    outputSchema: ToolSchemas["health.check"].output,
  }, handlers.healthCheck);
}
