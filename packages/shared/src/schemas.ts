import { z } from "zod";

/**
 * This file is intentionally verbose and explicit.
 * Every tool gets:
 *  - Input schema (required for MCP tool registration)
 *  - Output schema (used for contract tests + internal validation)
 *
 * Notes:
 * - IDs are UUID strings.
 * - The server MUST treat idempotency_key as required for any write path.
 * - Many fields are optional to keep the tool flexible, but validation is strict where it matters.
 */

export const UuidZ = z.string().uuid();
export const NonEmptyZ = z.string().min(1);
export const PathZ = z.string().min(1); // allow any OS path

export const MemoryScopeZ = z.enum(["project", "workspace_shared", "global"]);
export type MemoryScope = z.infer<typeof MemoryScopeZ>;

export const MemoryKindZ = z.enum([
  "spec",
  "plan",
  "architecture",
  "decision",
  "troubleshooting",
  "runbook",
  "environment_fact",
  "session_snapshot",
  "note",
  "snippet",
]);
export type MemoryKind = z.infer<typeof MemoryKindZ>;

export const ContentFormatZ = z.enum(["markdown", "plain", "json"]);
export type ContentFormat = z.infer<typeof ContentFormatZ>;

export const DocClassZ = z.enum([
  "app_spec",
  "feature_spec",
  "design_doc",
  "architecture_doc",
  "implementation_plan",
  "migration_plan",
  "test_plan",
  "rollout_plan",
  "adr",
  "code_map",
  "environment_registry",
  "environment_fact",
  "operations_overview",
  "runbook",
  "troubleshooting",
  "postmortem",
  "meeting_notes",
  "research_spike",
  "onboarding_guide",
  "release_notes",
  "security_review",
  "performance_notes",
  "glossary",
  "other",
]);
export type DocClass = z.infer<typeof DocClassZ>;

export const ClientNameZ = z.enum(["claude-code", "codex-tui", "cli", "unknown"]);
export type ClientName = z.infer<typeof ClientNameZ>;

export const DistanceMetricZ = z.enum(["cosine", "l2", "ip"]);
export type DistanceMetric = z.infer<typeof DistanceMetricZ>;

export const EmbeddingProviderZ = z.enum(["voyage", "jina", "openai_compat"]);
export type EmbeddingProvider = z.infer<typeof EmbeddingProviderZ>;

export const RelationZ = z.enum([
  "depends_on",
  "implements",
  "references",
  "caused_by",
  "mitigates",
  "supersedes",
  "relates_to",
]);
export type Relation = z.infer<typeof RelationZ>;

export const PaginationZ = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export const ProjectRefZ = z.object({
  project_id: UuidZ.optional(), // if omitted, server uses active project for the connection
});

export const WorkspaceRefZ = z.object({
  workspace_id: UuidZ.optional(),
  workspace_name: z.string().min(1).max(200).optional(), // for "default" or named workspaces
});

export const IdempotencyZ = z.object({
  idempotency_key: z.string().min(8).max(200),
});

export const TagListZ = z.array(z.string().min(1).max(64)).max(64).default([]);

export const LinkInputZ = z.object({
  to: z.object({
    item_id: UuidZ.optional(),
    canonical_key: z.string().min(1).max(400).optional(),
  }),
  relation: RelationZ,
  weight: z.number().min(0).max(100).default(1.0),
  metadata: z.record(z.any()).default({}),
});

export const ContentInputZ = z.object({
  format: ContentFormatZ.default("markdown"),
  text: z.string().min(1),
  json: z.record(z.any()).optional(), // if format="json", this may be populated
});

export const SectionRefZ = z.object({
  section_anchor: z.string().min(1).max(500),
  heading_path: z.array(z.string().min(1)).max(64).optional(),
});

/* =============================================================================
 * projects.resolve
 * ============================================================================= */

export const ProjectsResolveInputZ = WorkspaceRefZ.extend({
  cwd: PathZ.optional(),             // recommended
  repo_url: z.string().url().optional(), // preferred stable identity if available
  project_key: z.string().min(8).max(256).optional(), // advanced: user-specified
  display_name: z.string().min(1).max(200).optional(),
  create_if_missing: z.boolean().default(true),
});

export const ProjectsResolveOutputZ = z.object({
  workspace_id: UuidZ,
  project_id: UuidZ,
  project_key: z.string(),
  display_name: z.string(),
  repo_url: z.string().nullable(),
});

/* =============================================================================
 * projects.list
 * ============================================================================= */

export const ProjectsListInputZ = WorkspaceRefZ.extend({
  ...PaginationZ.shape,
  include_archived: z.boolean().default(false),
});

export const ProjectsListOutputZ = z.object({
  workspace_id: UuidZ.optional(),
  projects: z.array(z.object({
    project_id: UuidZ,
    project_key: z.string(),
    display_name: z.string(),
    repo_url: z.string().nullable(),
    created_at: z.string(),
  })),
  next_offset: z.number().int().min(0).optional(),
});

/* =============================================================================
 * sessions.start / sessions.end
 * ============================================================================= */

export const SessionsStartInputZ = ProjectRefZ.extend({
  client_name: ClientNameZ.default("unknown"),
  metadata: z.record(z.any()).default({}),
});

export const SessionsStartOutputZ = z.object({
  session_id: UuidZ,
  started_at: z.string(),
});

export const SessionsEndInputZ = ProjectRefZ.extend({
  session_id: UuidZ,
  summary: z.string().max(2000).optional(),
  create_snapshot: z.boolean().default(false),
  snapshot: z.object({
    title: z.string().min(1).max(200).default("Session Snapshot"),
    content: ContentInputZ,
    tags: TagListZ.optional(),
  }).optional(),
  idempotency_key: z.string().min(8).max(200).optional(), // required if create_snapshot=true
});

export const SessionsEndOutputZ = z.object({
  session_id: UuidZ,
  ended_at: z.string(),
  snapshot_item_id: UuidZ.optional(),
  snapshot_version_id: UuidZ.optional(),
});

/* =============================================================================
 * embedding_profiles.*
 * ============================================================================= */

export const EmbeddingProfilesListInputZ = ProjectRefZ.extend({
  include_inactive: z.boolean().default(false),
});

export const EmbeddingProfilesListOutputZ = z.object({
  profiles: z.array(z.object({
    embedding_profile_id: UuidZ,
    name: z.string(),
    provider: EmbeddingProviderZ,
    model: z.string(),
    dims: z.number().int().min(8).max(2000),
    distance: DistanceMetricZ,
    is_active: z.boolean(),
    created_at: z.string(),
  })),
});

export const EmbeddingProfilesUpsertInputZ = ProjectRefZ.extend({
  ...IdempotencyZ.shape,
  embedding_profile_id: UuidZ.optional(), // if present, update; else create
  name: z.string().min(1).max(128),
  provider: EmbeddingProviderZ,
  model: z.string().min(1).max(200),
  dims: z.number().int().min(8).max(2000),
  distance: DistanceMetricZ.default("cosine"),
  provider_config: z.record(z.any()).default({}),
  set_active: z.boolean().default(false),
});

export const EmbeddingProfilesUpsertOutputZ = z.object({
  embedding_profile_id: UuidZ,
  created: z.boolean(),
  index_created: z.boolean(), // whether server created the pgvector index for this profile
});

export const EmbeddingProfilesActivateInputZ = ProjectRefZ.extend({
  embedding_profile_id: UuidZ,
  idempotency_key: z.string().min(8).max(200),
});

export const EmbeddingProfilesActivateOutputZ = z.object({
  embedding_profile_id: UuidZ,
  activated: z.boolean(),
});

/* =============================================================================
 * memory.commit
 * ============================================================================= */

export const MemoryCommitEntryZ = z.object({
  // Identify existing item (one of these), or create new
  item_id: UuidZ.optional(),
  canonical_key: z.string().min(1).max(400).optional(),

  // Classification
  kind: MemoryKindZ,
  scope: MemoryScopeZ.default("project"),
  doc_class: DocClassZ.optional(),

  title: z.string().min(1).max(300),
  pinned: z.boolean().optional(),
  tags: TagListZ.optional(),
  metadata: z.record(z.any()).default({}),

  content: ContentInputZ,

  // Optional edges created from this item to others
  links: z.array(LinkInputZ).max(64).optional(),
});

export const MemoryCommitInputZ = ProjectRefZ.extend({
  ...IdempotencyZ.shape,
  session_id: UuidZ.optional(),
  author: z.string().max(200).optional(),
  summary: z.string().max(2000).optional(),

  entries: z.array(MemoryCommitEntryZ).min(1).max(50),
});

export const MemoryCommitOutputZ = z.object({
  commit_id: UuidZ,
  deduped: z.boolean(), // true if idempotency hit and commit already existed
  results: z.array(z.object({
    item_id: UuidZ,
    version_id: UuidZ,
    version_num: z.number().int().min(1),
    canonical_key: z.string().nullable(),
  })),
});

/* =============================================================================
 * memory.get
 * ============================================================================= */

export const MemoryGetInputZ = ProjectRefZ.extend({
  item_id: UuidZ.optional(),
  canonical_key: z.string().min(1).max(400).optional(),
  version_num: z.number().int().min(1).optional(),
  include_content: z.boolean().default(true),
  max_chars: z.number().int().min(200).max(200_000).default(20_000),
});

export const MemoryGetOutputZ = z.object({
  item: z.object({
    item_id: UuidZ,
    kind: MemoryKindZ,
    scope: MemoryScopeZ,
    title: z.string(),
    canonical_key: z.string().nullable(),
    doc_class: z.string().nullable(),
    pinned: z.boolean(),
    status: z.string(),
    tags: z.array(z.string()),
    metadata: z.record(z.any()),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  version: z.object({
    version_id: UuidZ,
    version_num: z.number().int().min(1),
    commit_id: UuidZ.nullable(),
    content_format: ContentFormatZ,
    content_text: z.string(),
    checksum: z.string(),
    created_at: z.string(),
  }).optional(),
  truncated: z.boolean().optional(),
});

/* =============================================================================
 * memory.history
 * ============================================================================= */

export const MemoryHistoryInputZ = ProjectRefZ.extend({
  item_id: UuidZ.optional(),
  canonical_key: z.string().min(1).max(400).optional(),
  ...PaginationZ.shape,
});

export const MemoryHistoryOutputZ = z.object({
  item_id: UuidZ,
  versions: z.array(z.object({
    version_id: UuidZ,
    version_num: z.number().int(),
    commit_id: UuidZ.nullable(),
    checksum: z.string(),
    created_at: z.string(),
  })),
  next_offset: z.number().int().optional(),
});

/* =============================================================================
 * memory.diff
 * ============================================================================= */

export const MemoryDiffInputZ = ProjectRefZ.extend({
  item_id: UuidZ.optional(),
  canonical_key: z.string().min(1).max(400).optional(),
  from_version_num: z.number().int().min(1),
  to_version_num: z.number().int().min(1),
  context_lines: z.number().int().min(0).max(50).default(3),
});

export const MemoryDiffOutputZ = z.object({
  item_id: UuidZ,
  from_version_num: z.number().int(),
  to_version_num: z.number().int(),
  unified_diff: z.string(), // textual unified diff
});

/* =============================================================================
 * memory.pin / memory.unpin
 * ============================================================================= */

export const MemoryPinInputZ = ProjectRefZ.extend({
  item_id: UuidZ.optional(),
  canonical_key: z.string().min(1).max(400).optional(),
  idempotency_key: z.string().min(8).max(200),
});

export const MemoryPinOutputZ = z.object({
  item_id: UuidZ,
  pinned: z.boolean(),
});

export const MemoryUnpinInputZ = MemoryPinInputZ;
export const MemoryUnpinOutputZ = MemoryPinOutputZ;

/* =============================================================================
 * memory.archive
 * ============================================================================= */

export const MemoryArchiveInputZ = ProjectRefZ.extend({
  item_id: UuidZ.optional(),
  canonical_key: z.string().min(1).max(400).optional(),
  status: z.enum(["archived", "deleted"]).default("archived"),
  idempotency_key: z.string().min(8).max(200),
});

export const MemoryArchiveOutputZ = z.object({
  item_id: UuidZ,
  status: z.string(),
});

/* =============================================================================
 * memory.link
 * ============================================================================= */

export const MemoryLinkInputZ = ProjectRefZ.extend({
  idempotency_key: z.string().min(8).max(200),
  from: z.object({
    item_id: UuidZ.optional(),
    canonical_key: z.string().min(1).max(400).optional(),
  }),
  to: z.object({
    item_id: UuidZ.optional(),
    canonical_key: z.string().min(1).max(400).optional(),
  }),
  relation: RelationZ,
  weight: z.number().min(0).max(100).default(1.0),
  metadata: z.record(z.any()).default({}),
});

export const MemoryLinkOutputZ = z.object({
  link_id: UuidZ,
});

/* =============================================================================
 * memory.search
 * ============================================================================= */

export const MemorySearchFiltersZ = z.object({
  kinds: z.array(MemoryKindZ).max(16).optional(),
  scopes: z.array(MemoryScopeZ).max(3).optional(),
  tags_all: z.array(z.string()).max(16).optional(),
  tags_any: z.array(z.string()).max(16).optional(),
  pinned_only: z.boolean().optional(),
  canonical_only: z.boolean().optional(),
  doc_classes: z.array(z.string().min(1).max(64)).max(16).optional(),
  created_after: z.string().datetime({ offset: true }).optional(),
});

export const MemoryListInputZ = ProjectRefZ.extend({
  filters: MemorySearchFiltersZ.default({}),
  include_archived: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export const MemoryListOutputZ = z.object({
  items: z.array(z.object({
    item_id: UuidZ,
    title: z.string(),
    kind: MemoryKindZ,
    scope: MemoryScopeZ,
    canonical_key: z.string().nullable(),
    doc_class: z.string().nullable(),
    pinned: z.boolean(),
    status: z.string(),
    tags: z.array(z.string()),
    created_at: z.string(),
    updated_at: z.string(),
    resource_uri: z.string(),
  })),
  next_offset: z.number().int().min(0).optional(),
});

export const MemorySearchInputZ = ProjectRefZ.extend({
  query: z.string().min(1).max(2000),
  filters: MemorySearchFiltersZ.default({}),
  lexical_top_k: z.number().int().min(1).max(200).default(40),
  semantic_top_k: z.number().int().min(1).max(200).default(40),
  include_chunks: z.boolean().default(true),
  max_chunk_chars: z.number().int().min(100).max(4000).default(600),
  debug: z.boolean().default(false),
});

export const MemorySearchOutputZ = z.object({
  query: z.string(),
  results: z.array(z.object({
    item: z.object({
      item_id: UuidZ,
      title: z.string(),
      kind: MemoryKindZ,
      scope: MemoryScopeZ,
      canonical_key: z.string().nullable(),
      pinned: z.boolean(),
      tags: z.array(z.string()),
    }),
    best_chunks: z.array(z.object({
      chunk_id: UuidZ,
      version_id: UuidZ,
      version_num: z.number().int(),
      score: z.number(),
      excerpt: z.string(),
      heading_path: z.array(z.string()),
      section_anchor: z.string().nullable(),
    })).optional(),
    resource_uri: z.string(),
  })),
  debug: z.record(z.any()).optional(),
});

/* =============================================================================
 * memory.restore
 * ============================================================================= */

export const MemoryRestoreInputZ = ProjectRefZ.extend({
  goal: z.string().max(2000).optional(),
  max_items: z.number().int().min(1).max(50).default(12),
  max_chars: z.number().int().min(2000).max(200_000).default(30_000),

  include_canonical: z.boolean().default(true),
  include_latest_snapshot: z.boolean().default(true),
  include_recent_troubleshooting: z.boolean().default(true),

  troubleshooting_days: z.number().int().min(1).max(365).default(30),
  troubleshooting_max: z.number().int().min(0).max(50).default(6),

  include_context_pack: z.boolean().default(false),
});

export const MemoryRestoreOutputZ = z.object({
  bundle_id: UuidZ,
  bundle_summary: z.string(),
  items: z.array(z.object({
    item_id: UuidZ,
    title: z.string(),
    kind: MemoryKindZ,
    canonical_key: z.string().nullable(),
    resource_uri: z.string(),
  })),
  context_pack: z.object({
    max_chars: z.number().int(),
    sections: z.array(z.object({
      item_id: UuidZ,
      canonical_key: z.string().nullable(),
      section_anchor: z.string().nullable(),
      heading_path: z.array(z.string()),
      excerpt: z.string(),
      resource_uri: z.string(),
    })),
  }).optional(),
});

/* =============================================================================
 * canonical.*
 * ============================================================================= */

export const CanonicalUpsertInputZ = ProjectRefZ.extend({
  ...IdempotencyZ.shape,
  canonical_key: z.string().min(1).max(400),
  doc_class: DocClassZ,
  title: z.string().min(1).max(300),
  tags: TagListZ.optional(),
  metadata: z.record(z.any()).default({}),
  pinned: z.boolean().default(true),

  content: ContentInputZ,

  links: z.array(LinkInputZ).max(64).optional(),
});

export const CanonicalUpsertFileInputZ = ProjectRefZ.extend({
  ...IdempotencyZ.shape,
  canonical_key: z.string().min(1).max(400),
  doc_class: DocClassZ,
  title: z.string().min(1).max(300),
  tags: TagListZ.optional(),
  metadata: z.record(z.any()).default({}),
  pinned: z.boolean().default(true),

  path: PathZ,
  format: ContentFormatZ.default("markdown"),

  links: z.array(LinkInputZ).max(64).optional(),
});

export const CanonicalUpsertOutputZ = z.object({
  item_id: UuidZ,
  version_id: UuidZ,
  version_num: z.number().int().min(1),
  canonical_key: z.string(),
});

export const CanonicalUpsertFileOutputZ = CanonicalUpsertOutputZ;

export const CanonicalGetInputZ = ProjectRefZ.extend({
  canonical_key: z.string().min(1).max(400),
  version_num: z.number().int().min(1).optional(),
  include_content: z.boolean().default(true),
  max_chars: z.number().int().min(200).max(500_000).default(50_000),
});

export const CanonicalGetOutputZ = MemoryGetOutputZ.extend({
  canonical_key: z.string(),
});

export const CanonicalOutlineInputZ = ProjectRefZ.extend({
  canonical_key: z.string().min(1).max(400),
  version_num: z.number().int().min(1).optional(),
});

export const CanonicalOutlineOutputZ = z.object({
  item_id: UuidZ,
  version_id: UuidZ,
  version_num: z.number().int(),
  sections: z.array(z.object({
    section_anchor: z.string(),
    heading_path: z.array(z.string()),
    start_char: z.number().int().nullable(),
    end_char: z.number().int().nullable(),
  })),
});

export const CanonicalGetSectionInputZ = ProjectRefZ.extend({
  canonical_key: z.string().min(1).max(400),
  section_anchor: z.string().min(1).max(500),
  version_num: z.number().int().min(1).optional(),
  max_chars: z.number().int().min(200).max(200_000).default(30_000),
});

export const CanonicalGetSectionOutputZ = z.object({
  item_id: UuidZ,
  version_id: UuidZ,
  version_num: z.number().int(),
  canonical_key: z.string(),
  section_anchor: z.string(),
  heading_path: z.array(z.string()),
  text: z.string(),
  truncated: z.boolean(),
});

export const CanonicalContextPackInputZ = ProjectRefZ.extend({
  canonical_key: z.string().min(1).max(400),
  goal: z.string().min(1).max(2000),
  max_chars: z.number().int().min(2000).max(200_000).default(30_000),
  version_num: z.number().int().min(1).optional(),
});

export const CanonicalContextPackOutputZ = z.object({
  canonical_key: z.string(),
  item_id: UuidZ,
  version_id: UuidZ,
  version_num: z.number().int(),
  max_chars: z.number().int(),
  sections: z.array(z.object({
    section_anchor: z.string().nullable(),
    heading_path: z.array(z.string()),
    excerpt: z.string(),
    resource_uri: z.string(),
  })),
});

/* =============================================================================
 * admin.*
 * ============================================================================= */

export const AdminReindexProfileInputZ = ProjectRefZ.extend({
  embedding_profile_id: UuidZ,
  idempotency_key: z.string().min(8).max(200),
  mode: z.enum(["enqueue", "inline"]).default("enqueue"),
});

export const AdminReindexProfileOutputZ = z.object({
  embedding_profile_id: UuidZ,
  enqueued: z.boolean(),
});

export const AdminReingestVersionInputZ = ProjectRefZ.extend({
  version_id: UuidZ,
  idempotency_key: z.string().min(8).max(200),
  include_embedding: z.boolean().default(true),
});

export const AdminReingestVersionOutputZ = z.object({
  version_id: UuidZ,
  enqueued: z.boolean(),
});

/* =============================================================================
 * health.check
 * ============================================================================= */

export const HealthCheckInputZ = z.object({});

export const HealthCheckOutputZ = z.object({
  ok: z.boolean(),
  database_ok: z.boolean(),
  worker_backlog: z.number().int().min(0),
  active_embedding_profile_id: UuidZ.nullable(),
  time: z.string(),
});

/* =============================================================================
 * Tool registry helper
 * ============================================================================= */

export const ToolSchemas = {
  "projects.resolve": { input: ProjectsResolveInputZ, output: ProjectsResolveOutputZ },
  "projects.list": { input: ProjectsListInputZ, output: ProjectsListOutputZ },

  "sessions.start": { input: SessionsStartInputZ, output: SessionsStartOutputZ },
  "sessions.end": { input: SessionsEndInputZ, output: SessionsEndOutputZ },

  "embedding_profiles.list": { input: EmbeddingProfilesListInputZ, output: EmbeddingProfilesListOutputZ },
  "embedding_profiles.upsert": { input: EmbeddingProfilesUpsertInputZ, output: EmbeddingProfilesUpsertOutputZ },
  "embedding_profiles.activate": { input: EmbeddingProfilesActivateInputZ, output: EmbeddingProfilesActivateOutputZ },

  "memory.commit": { input: MemoryCommitInputZ, output: MemoryCommitOutputZ },
  "memory.get": { input: MemoryGetInputZ, output: MemoryGetOutputZ },
  "memory.list": { input: MemoryListInputZ, output: MemoryListOutputZ },
  "memory.search": { input: MemorySearchInputZ, output: MemorySearchOutputZ },
  "memory.restore": { input: MemoryRestoreInputZ, output: MemoryRestoreOutputZ },
  "memory.history": { input: MemoryHistoryInputZ, output: MemoryHistoryOutputZ },
  "memory.diff": { input: MemoryDiffInputZ, output: MemoryDiffOutputZ },
  "memory.pin": { input: MemoryPinInputZ, output: MemoryPinOutputZ },
  "memory.unpin": { input: MemoryUnpinInputZ, output: MemoryUnpinOutputZ },
  "memory.link": { input: MemoryLinkInputZ, output: MemoryLinkOutputZ },
  "memory.archive": { input: MemoryArchiveInputZ, output: MemoryArchiveOutputZ },

  "canonical.upsert": { input: CanonicalUpsertInputZ, output: CanonicalUpsertOutputZ },
  "canonical.upsert_file": { input: CanonicalUpsertFileInputZ, output: CanonicalUpsertFileOutputZ },
  "canonical.get": { input: CanonicalGetInputZ, output: CanonicalGetOutputZ },
  "canonical.outline": { input: CanonicalOutlineInputZ, output: CanonicalOutlineOutputZ },
  "canonical.get_section": { input: CanonicalGetSectionInputZ, output: CanonicalGetSectionOutputZ },
  "canonical.context_pack": { input: CanonicalContextPackInputZ, output: CanonicalContextPackOutputZ },

  "admin.reindex_profile": { input: AdminReindexProfileInputZ, output: AdminReindexProfileOutputZ },
  "admin.reingest_version": { input: AdminReingestVersionInputZ, output: AdminReingestVersionOutputZ },

  "health.check": { input: HealthCheckInputZ, output: HealthCheckOutputZ },
} as const;

export type ToolSchemaRegistry = typeof ToolSchemas;
