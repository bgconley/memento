import type { ToolSchemaRegistry } from "@memento/shared";
import type { z } from "zod";

/**
 * ToolHandlers is the narrow interface expected by registerTools().
 * Each handler should:
 * - Validate / normalize the project context (active project)
 * - Perform a single transaction for write tools
 * - Return a JSON-serializable object matching the corresponding Output schema
 */
type HandlerFor<TName extends keyof ToolSchemaRegistry> =
  (input: z.input<ToolSchemaRegistry[TName]["input"]>) => Promise<{
    content: unknown[];
    structuredContent: z.output<ToolSchemaRegistry[TName]["output"]>;
  }>;

export type ToolHandlers = {
  projectsResolve: HandlerFor<"projects.resolve">;
  projectsList: HandlerFor<"projects.list">;

  sessionsStart: HandlerFor<"sessions.start">;
  sessionsEnd: HandlerFor<"sessions.end">;

  embeddingProfilesList: HandlerFor<"embedding_profiles.list">;
  embeddingProfilesUpsert: HandlerFor<"embedding_profiles.upsert">;
  embeddingProfilesActivate: HandlerFor<"embedding_profiles.activate">;

  memoryCommit: HandlerFor<"memory.commit">;
  memoryGet: HandlerFor<"memory.get">;
  memorySearch: HandlerFor<"memory.search">;
  memoryRestore: HandlerFor<"memory.restore">;
  memoryHistory: HandlerFor<"memory.history">;
  memoryDiff: HandlerFor<"memory.diff">;
  memoryPin: HandlerFor<"memory.pin">;
  memoryUnpin: HandlerFor<"memory.unpin">;
  memoryLink: HandlerFor<"memory.link">;
  memoryArchive: HandlerFor<"memory.archive">;

  canonicalUpsert: HandlerFor<"canonical.upsert">;
  canonicalUpsertFile: HandlerFor<"canonical.upsert_file">;
  canonicalGet: HandlerFor<"canonical.get">;
  canonicalOutline: HandlerFor<"canonical.outline">;
  canonicalGetSection: HandlerFor<"canonical.get_section">;
  canonicalContextPack: HandlerFor<"canonical.context_pack">;

  adminReindexProfile: HandlerFor<"admin.reindex_profile">;
  adminReingestVersion: HandlerFor<"admin.reingest_version">;
  healthCheck: HandlerFor<"health.check">;
};
