// Centralized tool names so the MCP server and tests share the same strings.
// Keep these stable to avoid breaking client configs.

export const ToolNames = {
  projectsResolve: "projects.resolve",
  projectsList: "projects.list",

  sessionsStart: "sessions.start",
  sessionsEnd: "sessions.end",

  embeddingProfilesList: "embedding_profiles.list",
  embeddingProfilesUpsert: "embedding_profiles.upsert",
  embeddingProfilesActivate: "embedding_profiles.activate",

  memoryCommit: "memory.commit",
  memoryGet: "memory.get",
  memorySearch: "memory.search",
  memoryRestore: "memory.restore",
  memoryHistory: "memory.history",
  memoryDiff: "memory.diff",
  memoryPin: "memory.pin",
  memoryUnpin: "memory.unpin",
  memoryLink: "memory.link",
  memoryArchive: "memory.archive",

  canonicalUpsert: "canonical.upsert",
  canonicalUpsertFile: "canonical.upsert_file",
  canonicalGet: "canonical.get",
  canonicalOutline: "canonical.outline",
  canonicalGetSection: "canonical.get_section",
  canonicalContextPack: "canonical.context_pack",

  adminReindexProfile: "admin.reindex_profile",
  adminReingestVersion: "admin.reingest_version",
  healthCheck: "health.check",
} as const;

export type ToolName = (typeof ToolNames)[keyof typeof ToolNames];
