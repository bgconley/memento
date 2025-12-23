import crypto from "node:crypto";
import type { Pool } from "pg";
import { ToolSchemas } from "@memento/shared";
import type { ToolHandlers } from "./toolHandlers";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types";
import {
  NotFoundError,
  ValidationError,
  checkDbHealth,
  createMemoryLink,
  createMemoryVersion,
  ensureProfileIndex,
  endSession,
  enqueueOutboxEvent,
  getLatestMemoryVersion,
  getMemoryItemByCanonicalKey,
  getMemoryItemById,
  getMemoryVersion,
  getOrCreateWorkspace,
  getEmbeddingProfileByName,
  getEmbeddingProfileById,
  buildOutlineFromChunks,
  hybridSearch,
  insertOrGetCommit,
  listEmbeddingProfiles,
  listMemoryVersions,
  resolveProject,
  setMemoryItemPinned,
  setMemoryItemStatus,
  startSession,
  toToolError,
  upsertEmbeddingProfile,
  activateEmbeddingProfile,
  upsertCanonicalDoc,
  upsertMemoryItem,
  withTransaction,
  requireWorkspaceById,
} from "@memento/core";
import { resolveProjectId, setActiveProject } from "./context";
import type { RequestContext } from "./context";

const NOT_IMPLEMENTED_CODE = "not_implemented";

type ToolName = keyof typeof ToolSchemas;

type HandlerInput<TName extends ToolName> =
  (typeof ToolSchemas)[TName]["input"] extends { _output: infer T }
    ? T
    : unknown;

type HandlerOutput<TName extends ToolName> =
  (typeof ToolSchemas)[TName]["output"] extends { _output: infer T }
    ? T
    : unknown;

export type HandlerDependencies = {
  pool: Pool;
  context: RequestContext;
};

function toMcpError(err: unknown): McpError {
  const toolError = toToolError(err);
  const code = toolError.code === "validation" ? ErrorCode.InvalidParams : ErrorCode.InternalError;
  return new McpError(code, JSON.stringify(toolError));
}

function notImplementedError(toolName: string): McpError {
  return new McpError(
    ErrorCode.InternalError,
    JSON.stringify({ code: NOT_IMPLEMENTED_CODE, message: `${toolName} not implemented` })
  );
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function scopedIdempotencyKey(toolName: string, idempotencyKey: string): string {
  return `${toolName}:${idempotencyKey}`;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxChars), truncated: true };
}

function buildItemUri(projectId: string, itemId: string): string {
  return `memory://projects/${projectId}/items/${itemId}`;
}

function buildSectionUri(projectId: string, itemId: string, sectionAnchor: string): string {
  return `memory://projects/${projectId}/items/${itemId}@latest#${sectionAnchor}`;
}

function buildVersionUri(
  projectId: string,
  itemId: string,
  versionNum: number,
  sectionAnchor?: string | null
): string {
  const base = `memory://projects/${projectId}/items/${itemId}@v${versionNum}`;
  if (sectionAnchor) {
    return `${base}#${sectionAnchor}`;
  }
  return base;
}

function wrapTool<TName extends ToolName>(
  toolName: TName,
  fn: (input: HandlerInput<TName>) => Promise<HandlerOutput<TName>>
) {
  return async (rawInput: unknown) => {
    const parsed = ToolSchemas[toolName].input.parse(rawInput) as HandlerInput<TName>;
    try {
      const output = await fn(parsed);
      ToolSchemas[toolName].output.parse(output);
      return { content: [], structuredContent: output };
    } catch (err) {
      if (err instanceof McpError) {
        throw err;
      }
      throw toMcpError(err);
    }
  };
}

export function createHandlers(deps: HandlerDependencies): ToolHandlers {
  const { pool, context } = deps;

  const stub = (toolName: ToolName) =>
    wrapTool(toolName, async () => {
      throw notImplementedError(toolName);
    });

  const resolveItemId = async (
    projectId: string,
    ref: { item_id?: string; canonical_key?: string }
  ): Promise<string> => {
    if (ref.item_id) {
      const item = await getMemoryItemById(pool, projectId, ref.item_id);
      if (!item) {
        throw new NotFoundError("Memory item not found", { item_id: ref.item_id });
      }
      return item.id;
    }

    if (ref.canonical_key) {
      const item = await getMemoryItemByCanonicalKey(pool, projectId, ref.canonical_key);
      if (!item) {
        throw new NotFoundError("Memory item not found", { canonical_key: ref.canonical_key });
      }
      return item.id;
    }

    throw new ValidationError("item_id or canonical_key is required");
  };

  return {
    projectsResolve: wrapTool("projects.resolve", async (input) => {
      const workspace = input.workspace_id
        ? await requireWorkspaceById(pool, input.workspace_id)
        : await getOrCreateWorkspace(pool, input.workspace_name ?? "default");

      const project = await resolveProject(pool, {
        workspace_id: workspace.id,
        repo_url: input.repo_url ?? null,
        cwd: input.cwd ?? null,
        project_key: input.project_key ?? null,
        display_name: input.display_name ?? null,
        create_if_missing: input.create_if_missing,
      });

      setActiveProject(context, workspace.id, project.id);

      return {
        workspace_id: workspace.id,
        project_id: project.id,
        project_key: project.project_key,
        display_name: project.display_name,
        repo_url: project.repo_url,
      };
    }),
    projectsList: stub("projects.list"),

    sessionsStart: wrapTool("sessions.start", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const session = await startSession(pool, {
        project_id: projectId,
        client_name: input.client_name,
        metadata: input.metadata,
      });

      return { session_id: session.id, started_at: toIsoString(session.started_at) };
    }),
    sessionsEnd: wrapTool("sessions.end", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);

      if (!input.create_snapshot) {
        const ended = await endSession(pool, projectId, input.session_id);
        return { session_id: ended.session_id, ended_at: toIsoString(ended.ended_at) };
      }

      if (!input.idempotency_key) {
        throw new ValidationError("idempotency_key is required when create_snapshot=true");
      }

      const snapshotInput = input.snapshot ?? null;
      const fallbackSnapshot =
        !snapshotInput && input.summary
          ? {
              title: "Session Snapshot",
              content: { format: "markdown", text: input.summary },
              tags: [],
            }
          : null;

      const snapshot = snapshotInput ?? fallbackSnapshot;
      if (!snapshot) {
        throw new ValidationError("snapshot or summary is required when create_snapshot=true");
      }

      return withTransaction(pool, async (client) => {
        const ended = await endSession(client, projectId, input.session_id);

        const commit = await insertOrGetCommit(client, {
          project_id: projectId,
          session_id: input.session_id,
          idempotency_key: scopedIdempotencyKey("sessions.end", input.idempotency_key),
          author: null,
          summary: input.summary ?? null,
        });

        if (commit.deduped) {
          const existing = await client.query(
            `SELECT mv.id AS version_id, mi.id AS item_id
             FROM memory_versions mv
             JOIN memory_items mi ON mi.id = mv.item_id
             WHERE mv.commit_id = $1
             ORDER BY mv.created_at DESC
             LIMIT 1`,
            [commit.commit_id]
          );

          if (!existing.rows[0]) {
            throw new NotFoundError("Snapshot not found for idempotency key", {
              commit_id: commit.commit_id,
            });
          }

          return {
            session_id: ended.session_id,
            ended_at: toIsoString(ended.ended_at),
            snapshot_item_id: existing.rows[0].item_id,
            snapshot_version_id: existing.rows[0].version_id,
          };
        }

        const item = await upsertMemoryItem(client, {
          project_id: projectId,
          scope: "project",
          kind: "session_snapshot",
          doc_class: null,
          title: snapshot.title,
          pinned: false,
          tags: snapshot.tags ?? [],
          metadata: { session_id: input.session_id },
          status: "active",
        });

        const checksum = crypto
          .createHash("sha256")
          .update(snapshot.content.text)
          .digest("hex");

        const version = await createMemoryVersion(client, {
          project_id: projectId,
          item_id: item.id,
          commit_id: commit.commit_id,
          content_format: snapshot.content.format,
          content_text: snapshot.content.text,
          content_json: snapshot.content.json ?? null,
          checksum,
        });

        await enqueueOutboxEvent(client, {
          project_id: projectId,
          event_type: "INGEST_VERSION",
          payload: { version_id: version.id },
        });

        await enqueueOutboxEvent(client, {
          project_id: projectId,
          event_type: "EMBED_VERSION",
          payload: { version_id: version.id },
        });

        return {
          session_id: ended.session_id,
          ended_at: toIsoString(ended.ended_at),
          snapshot_item_id: item.id,
          snapshot_version_id: version.id,
        };
      });
    }),

    embeddingProfilesList: wrapTool("embedding_profiles.list", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const profiles = await listEmbeddingProfiles(pool, projectId, input.include_inactive);

      return {
        profiles: profiles.map((profile) => ({
          embedding_profile_id: profile.id,
          name: profile.name,
          provider: profile.provider,
          model: profile.model,
          dims: profile.dims,
          distance: profile.distance,
          is_active: profile.is_active,
          created_at: toIsoString(profile.created_at),
        })),
      };
    }),
    embeddingProfilesUpsert: wrapTool("embedding_profiles.upsert", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const commitKey = scopedIdempotencyKey("embedding_profiles.upsert", input.idempotency_key);

      let profile = null as null | Awaited<ReturnType<typeof getEmbeddingProfileById>>;
      let created = false;

      await withTransaction(pool, async (client) => {
        const commit = await insertOrGetCommit(client, {
          project_id: projectId,
          session_id: null,
          idempotency_key: commitKey,
          author: null,
          summary: "embedding_profiles.upsert",
        });

        if (commit.deduped) {
          profile = input.embedding_profile_id
            ? await getEmbeddingProfileById(client, projectId, input.embedding_profile_id)
            : await getEmbeddingProfileByName(client, projectId, input.name);

          if (!profile) {
            throw new NotFoundError("Embedding profile not found", {
              embedding_profile_id: input.embedding_profile_id,
              name: input.name,
            });
          }

          return;
        }

        const result = await upsertEmbeddingProfile(client, {
          project_id: projectId,
          embedding_profile_id: input.embedding_profile_id ?? null,
          name: input.name,
          provider: input.provider,
          model: input.model,
          dims: input.dims,
          distance: input.distance,
          provider_config: input.provider_config,
          is_active: false,
        });

        profile = result.profile;
        created = result.created;

        if (input.set_active && profile) {
          profile = await activateEmbeddingProfile(client, projectId, profile.id);
        }
      });

      if (!profile) {
        throw new NotFoundError("Embedding profile not found", {
          embedding_profile_id: input.embedding_profile_id,
          name: input.name,
        });
      }

      const indexResult = await ensureProfileIndex(pool, profile.id, profile.dims, profile.distance, {
        concurrently: true,
      });

      return {
        embedding_profile_id: profile.id,
        created,
        index_created: indexResult.created,
      };
    }),
    embeddingProfilesActivate: wrapTool("embedding_profiles.activate", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const commitKey = scopedIdempotencyKey("embedding_profiles.activate", input.idempotency_key);

      let profile = null as null | Awaited<ReturnType<typeof getEmbeddingProfileById>>;

      await withTransaction(pool, async (client) => {
        const commit = await insertOrGetCommit(client, {
          project_id: projectId,
          session_id: null,
          idempotency_key: commitKey,
          author: null,
          summary: "embedding_profiles.activate",
        });

        if (commit.deduped) {
          profile = await getEmbeddingProfileById(client, projectId, input.embedding_profile_id);
          if (!profile) {
            throw new NotFoundError("Embedding profile not found", {
              embedding_profile_id: input.embedding_profile_id,
            });
          }
          return;
        }

        profile = await activateEmbeddingProfile(client, projectId, input.embedding_profile_id);
      });

      if (!profile) {
        throw new NotFoundError("Embedding profile not found", {
          embedding_profile_id: input.embedding_profile_id,
        });
      }

      await ensureProfileIndex(pool, profile.id, profile.dims, profile.distance, {
        concurrently: true,
      });

      return {
        embedding_profile_id: profile.id,
        activated: profile.is_active,
      };
    }),

    memoryCommit: wrapTool("memory.commit", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const commitKey = scopedIdempotencyKey("memory.commit", input.idempotency_key);

      return withTransaction(pool, async (client) => {
        const commit = await insertOrGetCommit(client, {
          project_id: projectId,
          session_id: input.session_id ?? null,
          idempotency_key: commitKey,
          author: input.author ?? null,
          summary: input.summary ?? null,
        });

        if (commit.deduped) {
          const rows = await client.query(
            `SELECT mv.id AS version_id, mv.version_num, mi.id AS item_id, mi.canonical_key
             FROM memory_versions mv
             JOIN memory_items mi ON mi.id = mv.item_id
             WHERE mv.commit_id = $1
             ORDER BY mv.created_at ASC`,
            [commit.commit_id]
          );

          return {
            commit_id: commit.commit_id,
            deduped: true,
            results: rows.rows.map((row) => ({
              item_id: row.item_id,
              version_id: row.version_id,
              version_num: row.version_num,
              canonical_key: row.canonical_key,
            })),
          };
        }

        const results: Array<{
          item_id: string;
          version_id: string;
          version_num: number;
          canonical_key: string | null;
        }> = [];

        for (const entry of input.entries) {
          const item = await upsertMemoryItem(client, {
            project_id: projectId,
            item_id: entry.item_id ?? null,
            canonical_key: entry.canonical_key ?? null,
            scope: entry.scope,
            kind: entry.kind,
            doc_class: entry.doc_class ?? null,
            title: entry.title,
            pinned: entry.pinned ?? null,
            tags: entry.tags ?? null,
            metadata: entry.metadata ?? {},
          });

          const checksum = crypto
            .createHash("sha256")
            .update(entry.content.text)
            .digest("hex");

          const version = await createMemoryVersion(client, {
            project_id: projectId,
            item_id: item.id,
            commit_id: commit.commit_id,
            content_format: entry.content.format,
            content_text: entry.content.text,
            content_json: entry.content.json ?? null,
            checksum,
          });

          await enqueueOutboxEvent(client, {
            project_id: projectId,
            event_type: "INGEST_VERSION",
            payload: { version_id: version.id },
          });

          await enqueueOutboxEvent(client, {
            project_id: projectId,
            event_type: "EMBED_VERSION",
            payload: { version_id: version.id },
          });

          if (entry.links?.length) {
            for (const link of entry.links) {
              const toItemId = await resolveItemId(projectId, link.to);
              await createMemoryLink(client, {
                project_id: projectId,
                from_item_id: item.id,
                to_item_id: toItemId,
                relation: link.relation,
                weight: link.weight,
                metadata: link.metadata,
              });
            }
          }

          results.push({
            item_id: item.id,
            version_id: version.id,
            version_num: version.version_num,
            canonical_key: item.canonical_key,
          });
        }

        return { commit_id: commit.commit_id, deduped: false, results };
      });
    }),
    memoryGet: wrapTool("memory.get", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);

      const item =
        input.item_id
          ? await getMemoryItemById(pool, projectId, input.item_id)
          : input.canonical_key
            ? await getMemoryItemByCanonicalKey(pool, projectId, input.canonical_key)
            : null;

      if (!item) {
        throw new NotFoundError("Memory item not found", {
          item_id: input.item_id,
          canonical_key: input.canonical_key,
        });
      }

      let version;
      let truncated = false;

      if (input.include_content) {
        const versionRow = input.version_num
          ? await getMemoryVersion(pool, projectId, item.id, input.version_num)
          : await getLatestMemoryVersion(pool, projectId, item.id);

        if (!versionRow) {
          throw new NotFoundError("Memory version not found", { item_id: item.id });
        }

        const truncatedContent = truncateText(versionRow.content_text, input.max_chars);
        truncated = truncatedContent.truncated;
        version = {
          version_id: versionRow.id,
          version_num: versionRow.version_num,
          commit_id: versionRow.commit_id,
          content_format: versionRow.content_format,
          content_text: truncatedContent.text,
          checksum: versionRow.checksum,
          created_at: toIsoString(versionRow.created_at),
        };
      }

      return {
        item: {
          item_id: item.id,
          kind: item.kind,
          scope: item.scope,
          title: item.title,
          canonical_key: item.canonical_key,
          doc_class: item.doc_class,
          pinned: item.pinned,
          status: item.status,
          tags: item.tags,
          metadata: item.metadata,
          created_at: toIsoString(item.created_at),
          updated_at: toIsoString(item.updated_at),
        },
        version,
        truncated: version ? truncated : undefined,
      };
    }),
    memorySearch: wrapTool("memory.search", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);

      const result = await hybridSearch(pool, {
        project_id: projectId,
        query: input.query,
        filters: input.filters,
        options: {
          lexical_top_k: input.lexical_top_k,
          semantic_top_k: input.semantic_top_k,
          include_chunks: input.include_chunks,
          max_chunk_chars: input.max_chunk_chars,
        },
      });

      return {
        query: result.query,
        results: result.results,
        debug: input.debug ? result.debug : undefined,
      };
    }),
    memoryRestore: wrapTool("memory.restore", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const items: Array<{
        item_id: string;
        title: string;
        kind: string;
        canonical_key: string | null;
        resource_uri: string;
      }> = [];
      const seen = new Set<string>();

      if (input.include_canonical) {
        const canonicalRows = await pool.query(
          `SELECT id, title, kind, canonical_key
           FROM memory_items
           WHERE project_id = $1
             AND status = 'active'
             AND canonical_key IS NOT NULL
             AND pinned = true
           ORDER BY updated_at DESC, id ASC
           LIMIT $2`,
          [projectId, input.max_items]
        );

        for (const row of canonicalRows.rows) {
          if (items.length >= input.max_items) break;
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          items.push({
            item_id: row.id,
            title: row.title,
            kind: row.kind,
            canonical_key: row.canonical_key,
            resource_uri: buildItemUri(projectId, row.id),
          });
        }
      }

      if (input.include_latest_snapshot && items.length < input.max_items) {
        const snapshot = await pool.query(
          `SELECT id, title, kind, canonical_key
           FROM memory_items
           WHERE project_id = $1
             AND status = 'active'
             AND kind = 'session_snapshot'
           ORDER BY updated_at DESC, id ASC
           LIMIT 1`,
          [projectId]
        );

        const row = snapshot.rows[0];
        if (row && !seen.has(row.id)) {
          seen.add(row.id);
          items.push({
            item_id: row.id,
            title: row.title,
            kind: row.kind,
            canonical_key: row.canonical_key,
            resource_uri: buildItemUri(projectId, row.id),
          });
        }
      }

      if (input.include_recent_troubleshooting && items.length < input.max_items) {
        const remaining = input.max_items - items.length;
        const troubleshooting = await pool.query(
          `SELECT id, title, kind, canonical_key
           FROM memory_items
           WHERE project_id = $1
             AND status = 'active'
             AND kind = 'troubleshooting'
             AND created_at >= now() - ($2 || ' days')::interval
           ORDER BY created_at DESC, id ASC
           LIMIT $3`,
          [projectId, input.troubleshooting_days, Math.min(remaining, input.troubleshooting_max)]
        );

        for (const row of troubleshooting.rows) {
          if (items.length >= input.max_items) break;
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          items.push({
            item_id: row.id,
            title: row.title,
            kind: row.kind,
            canonical_key: row.canonical_key,
            resource_uri: buildItemUri(projectId, row.id),
          });
        }
      }

      const bundleId = crypto.randomUUID();

      const output: {
        bundle_id: string;
        bundle_summary: string;
        items: typeof items;
        context_pack?: {
          max_chars: number;
          sections: Array<{
            item_id: string;
            canonical_key: string | null;
            section_anchor: string | null;
            heading_path: string[];
            excerpt: string;
            resource_uri: string;
          }>;
        };
      } = {
        bundle_id: bundleId,
        bundle_summary: `Restore bundle with ${items.length} items`,
        items,
      };

      if (input.include_context_pack) {
        const itemIds = items.map((entry) => entry.item_id);
        const query = input.goal ?? "project context";

        const searchResult = await hybridSearch(pool, {
          project_id: projectId,
          query,
          filters: { item_ids: itemIds },
          options: {
            lexical_top_k: Math.min(50, input.max_items * 5),
            semantic_top_k: Math.min(50, input.max_items * 5),
            include_chunks: true,
            max_chunk_chars: input.max_chars,
          },
        });

        const sections: Array<{
          item_id: string;
          canonical_key: string | null;
          section_anchor: string | null;
          heading_path: string[];
          excerpt: string;
          resource_uri: string;
        }> = [];

        let remaining = input.max_chars;

        for (const result of searchResult.results) {
          const chunks = result.best_chunks ?? [];
          for (const chunk of chunks) {
            if (remaining <= 0) break;
            const excerpt = chunk.excerpt.slice(0, remaining);
            if (!excerpt) continue;
            remaining -= excerpt.length;
            sections.push({
              item_id: result.item.item_id,
              canonical_key: result.item.canonical_key,
              section_anchor: chunk.section_anchor,
              heading_path: chunk.heading_path,
              excerpt,
              resource_uri: buildVersionUri(
                projectId,
                result.item.item_id,
                chunk.version_num,
                chunk.section_anchor
              ),
            });
            if (remaining <= 0) break;
          }
          if (remaining <= 0) break;
        }

        output.context_pack = {
          max_chars: input.max_chars,
          sections,
        };
      }

      return output;
    }),
    memoryHistory: wrapTool("memory.history", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);

      const itemId = input.item_id
        ? input.item_id
        : input.canonical_key
          ? await resolveItemId(projectId, { canonical_key: input.canonical_key })
          : null;

      if (!itemId) {
        throw new ValidationError("item_id or canonical_key is required");
      }

      const versions = await listMemoryVersions(
        pool,
        projectId,
        itemId,
        input.limit,
        input.offset
      );

      const nextOffset =
        versions.length === input.limit ? input.offset + input.limit : undefined;

      return {
        item_id: itemId,
        versions: versions.map((version) => ({
          version_id: version.id,
          version_num: version.version_num,
          commit_id: version.commit_id,
          checksum: version.checksum,
          created_at: toIsoString(version.created_at),
        })),
        next_offset: nextOffset,
      };
    }),
    memoryDiff: stub("memory.diff"),
    memoryPin: wrapTool("memory.pin", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const itemId = await resolveItemId(projectId, {
        item_id: input.item_id,
        canonical_key: input.canonical_key,
      });

      const commitKey = scopedIdempotencyKey("memory.pin", input.idempotency_key);

      return withTransaction(pool, async (client) => {
        const commit = await insertOrGetCommit(client, {
          project_id: projectId,
          session_id: null,
          idempotency_key: commitKey,
          author: null,
          summary: "memory.pin",
        });

        const item = commit.deduped
          ? await getMemoryItemById(client, projectId, itemId)
          : await setMemoryItemPinned(client, projectId, itemId, true);

        if (!item) {
          throw new NotFoundError("Memory item not found", { item_id: itemId });
        }

        return { item_id: item.id, pinned: item.pinned };
      });
    }),
    memoryUnpin: wrapTool("memory.unpin", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const itemId = await resolveItemId(projectId, {
        item_id: input.item_id,
        canonical_key: input.canonical_key,
      });

      const commitKey = scopedIdempotencyKey("memory.unpin", input.idempotency_key);

      return withTransaction(pool, async (client) => {
        const commit = await insertOrGetCommit(client, {
          project_id: projectId,
          session_id: null,
          idempotency_key: commitKey,
          author: null,
          summary: "memory.unpin",
        });

        const item = commit.deduped
          ? await getMemoryItemById(client, projectId, itemId)
          : await setMemoryItemPinned(client, projectId, itemId, false);

        if (!item) {
          throw new NotFoundError("Memory item not found", { item_id: itemId });
        }

        return { item_id: item.id, pinned: item.pinned };
      });
    }),
    memoryLink: wrapTool("memory.link", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const commitKey = scopedIdempotencyKey("memory.link", input.idempotency_key);

      return withTransaction(pool, async (client) => {
        const existing = await client.query(
          `SELECT id FROM memory_links
           WHERE project_id = $1
             AND metadata->>'idempotency_key' = $2
           LIMIT 1`,
          [projectId, commitKey]
        );

        if (existing.rows[0]) {
          return { link_id: existing.rows[0].id };
        }

        const fromItemId = await resolveItemId(projectId, input.from);
        const toItemId = await resolveItemId(projectId, input.to);

        const metadata = { ...input.metadata, idempotency_key: commitKey };

        const link = await createMemoryLink(client, {
          project_id: projectId,
          from_item_id: fromItemId,
          to_item_id: toItemId,
          relation: input.relation,
          weight: input.weight,
          metadata,
        });

        return { link_id: link.id };
      });
    }),
    memoryArchive: wrapTool("memory.archive", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const itemId = await resolveItemId(projectId, {
        item_id: input.item_id,
        canonical_key: input.canonical_key,
      });
      const commitKey = scopedIdempotencyKey("memory.archive", input.idempotency_key);

      return withTransaction(pool, async (client) => {
        const commit = await insertOrGetCommit(client, {
          project_id: projectId,
          session_id: null,
          idempotency_key: commitKey,
          author: null,
          summary: "memory.archive",
        });

        const item = commit.deduped
          ? await getMemoryItemById(client, projectId, itemId)
          : await setMemoryItemStatus(client, projectId, itemId, input.status);

        if (!item) {
          throw new NotFoundError("Memory item not found", { item_id: itemId });
        }

        return { item_id: item.id, status: item.status };
      });
    }),

    canonicalUpsert: wrapTool("canonical.upsert", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const commitKey = scopedIdempotencyKey("canonical.upsert", input.idempotency_key);

      const inferKind = (docClass: string) => {
        if (docClass.includes("plan")) return "plan";
        if (docClass.includes("runbook")) return "runbook";
        if (docClass.includes("troubleshooting")) return "troubleshooting";
        if (docClass.includes("environment")) return "environment_fact";
        return "spec";
      };

      return withTransaction(pool, async (client) => {
        const commit = await insertOrGetCommit(client, {
          project_id: projectId,
          session_id: null,
          idempotency_key: commitKey,
          author: null,
          summary: "canonical.upsert",
        });

        if (commit.deduped) {
          const existing = await client.query(
            `SELECT mv.id AS version_id, mv.version_num, mi.id AS item_id
             FROM memory_versions mv
             JOIN memory_items mi ON mi.id = mv.item_id
             WHERE mv.commit_id = $1 AND mi.canonical_key = $2
             ORDER BY mv.created_at DESC
             LIMIT 1`,
            [commit.commit_id, input.canonical_key]
          );

          if (existing.rows[0]) {
            return {
              item_id: existing.rows[0].item_id,
              version_id: existing.rows[0].version_id,
              version_num: existing.rows[0].version_num,
              canonical_key: input.canonical_key,
            };
          }

          const item = await getMemoryItemByCanonicalKey(client, projectId, input.canonical_key);
          if (!item) {
            throw new NotFoundError("Canonical item not found", {
              canonical_key: input.canonical_key,
            });
          }
          const version = await getLatestMemoryVersion(pool, projectId, item.id);
          if (!version) {
            throw new NotFoundError("Canonical version not found", { item_id: item.id });
          }

          return {
            item_id: item.id,
            version_id: version.id,
            version_num: version.version_num,
            canonical_key: input.canonical_key,
          };
        }

        const { item } = await upsertCanonicalDoc(client, {
          project_id: projectId,
          canonical_key: input.canonical_key,
          doc_class: input.doc_class,
          title: input.title,
          kind: inferKind(input.doc_class),
          scope: "project",
          pinned: input.pinned,
          status: "active",
          tags: input.tags ?? null,
          metadata: input.metadata ?? {},
        });

        const checksum = crypto
          .createHash("sha256")
          .update(input.content.text)
          .digest("hex");

        const version = await createMemoryVersion(client, {
          project_id: projectId,
          item_id: item.id,
          commit_id: commit.commit_id,
          content_format: input.content.format,
          content_text: input.content.text,
          content_json: input.content.json ?? null,
          checksum,
        });

        await enqueueOutboxEvent(client, {
          project_id: projectId,
          event_type: "INGEST_VERSION",
          payload: { version_id: version.id },
        });

        await enqueueOutboxEvent(client, {
          project_id: projectId,
          event_type: "EMBED_VERSION",
          payload: { version_id: version.id },
        });

        if (input.links?.length) {
          for (const link of input.links) {
            const toItemId = await resolveItemId(projectId, link.to);
            await createMemoryLink(client, {
              project_id: projectId,
              from_item_id: item.id,
              to_item_id: toItemId,
              relation: link.relation,
              weight: link.weight,
              metadata: link.metadata,
            });
          }
        }

        return {
          item_id: item.id,
          version_id: version.id,
          version_num: version.version_num,
          canonical_key: input.canonical_key,
        };
      });
    }),
    canonicalGet: wrapTool("canonical.get", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const item = await getMemoryItemByCanonicalKey(pool, projectId, input.canonical_key);
      if (!item) {
        throw new NotFoundError("Canonical item not found", {
          canonical_key: input.canonical_key,
        });
      }

      let version;
      let truncated = false;
      if (input.include_content) {
        const versionRow = input.version_num
          ? await getMemoryVersion(pool, projectId, item.id, input.version_num)
          : await getLatestMemoryVersion(pool, projectId, item.id);

        if (!versionRow) {
          throw new NotFoundError("Canonical version not found", { item_id: item.id });
        }

        const truncatedContent = truncateText(versionRow.content_text, input.max_chars);
        truncated = truncatedContent.truncated;
        version = {
          version_id: versionRow.id,
          version_num: versionRow.version_num,
          commit_id: versionRow.commit_id,
          content_format: versionRow.content_format,
          content_text: truncatedContent.text,
          checksum: versionRow.checksum,
          created_at: toIsoString(versionRow.created_at),
        };
      }

      return {
        canonical_key: input.canonical_key,
        item: {
          item_id: item.id,
          kind: item.kind,
          scope: item.scope,
          title: item.title,
          canonical_key: item.canonical_key,
          doc_class: item.doc_class,
          pinned: item.pinned,
          status: item.status,
          tags: item.tags,
          metadata: item.metadata,
          created_at: toIsoString(item.created_at),
          updated_at: toIsoString(item.updated_at),
        },
        version,
        truncated: version ? truncated : undefined,
      };
    }),
    canonicalOutline: wrapTool("canonical.outline", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const item = await getMemoryItemByCanonicalKey(pool, projectId, input.canonical_key);
      if (!item) {
        throw new NotFoundError("Canonical item not found", { canonical_key: input.canonical_key });
      }

      const version = input.version_num
        ? await getMemoryVersion(pool, projectId, item.id, input.version_num)
        : await getLatestMemoryVersion(pool, projectId, item.id);

      if (!version) {
        throw new NotFoundError("Canonical version not found", { item_id: item.id });
      }

      const chunks = await pool.query(
        `SELECT section_anchor, heading_path, start_char, end_char
         FROM memory_chunks
         WHERE version_id = $1
         ORDER BY chunk_index ASC`,
        [version.id]
      );

      const sections = buildOutlineFromChunks(chunks.rows).map((section) => ({
        section_anchor: section.section_anchor,
        heading_path: section.heading_path,
        start_char: section.start_char,
        end_char: section.end_char,
      }));

      return {
        item_id: item.id,
        version_id: version.id,
        version_num: version.version_num,
        sections,
      };
    }),
    canonicalGetSection: wrapTool("canonical.get_section", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const item = await getMemoryItemByCanonicalKey(pool, projectId, input.canonical_key);
      if (!item) {
        throw new NotFoundError("Canonical item not found", { canonical_key: input.canonical_key });
      }

      const version = input.version_num
        ? await getMemoryVersion(pool, projectId, item.id, input.version_num)
        : await getLatestMemoryVersion(pool, projectId, item.id);

      if (!version) {
        throw new NotFoundError("Canonical version not found", { item_id: item.id });
      }

      const chunkRows = await pool.query(
        `SELECT chunk_index, chunk_text, heading_path, section_anchor, start_char, end_char
         FROM memory_chunks
         WHERE version_id = $1 AND section_anchor = $2
         ORDER BY chunk_index ASC`,
        [version.id, input.section_anchor]
      );

      if (chunkRows.rows.length === 0) {
        throw new NotFoundError("Section anchor not found", {
          section_anchor: input.section_anchor,
        });
      }

      const headingPath = chunkRows.rows[0].heading_path ?? [];
      const contentText = version.content_text ?? "";

      const startValues = chunkRows.rows
        .map((row) => (row.start_char === null ? null : Number(row.start_char)))
        .filter((value): value is number => value !== null);
      const endValues = chunkRows.rows
        .map((row) => (row.end_char === null ? null : Number(row.end_char)))
        .filter((value): value is number => value !== null);

      let text = "";
      if (contentText && startValues.length > 0 && endValues.length > 0) {
        const startChar = Math.min(...startValues);
        const endChar = Math.max(...endValues);
        if (startChar >= 0 && endChar > startChar && endChar <= contentText.length) {
          text = contentText.slice(startChar, endChar);
        }
      }

      if (!text) {
        text = chunkRows.rows.map((row) => row.chunk_text).join("");
      }

      const truncated = text.length > input.max_chars;
      if (truncated) {
        text = text.slice(0, input.max_chars);
      }

      return {
        item_id: item.id,
        version_id: version.id,
        version_num: version.version_num,
        canonical_key: input.canonical_key,
        section_anchor: input.section_anchor,
        heading_path: headingPath,
        text,
        truncated,
      };
    }),
    canonicalContextPack: wrapTool("canonical.context_pack", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);

      const item = await getMemoryItemByCanonicalKey(pool, projectId, input.canonical_key);
      if (!item) {
        throw new NotFoundError("Canonical item not found", { canonical_key: input.canonical_key });
      }

      const version = input.version_num
        ? await getMemoryVersion(pool, projectId, item.id, input.version_num)
        : await getLatestMemoryVersion(pool, projectId, item.id);

      if (!version) {
        throw new NotFoundError("Canonical version not found", { item_id: item.id });
      }

      const searchResult = await hybridSearch(pool, {
        project_id: projectId,
        query: input.goal,
        filters: { item_ids: [item.id], canonical_only: true },
        options: {
          lexical_top_k: 50,
          semantic_top_k: 50,
          include_chunks: true,
          max_chunk_chars: input.max_chars,
        },
      });

      let remaining = input.max_chars;
      const sections: Array<{
        section_anchor: string | null;
        heading_path: string[];
        excerpt: string;
        resource_uri: string;
      }> = [];

      for (const result of searchResult.results) {
        const chunks = result.best_chunks ?? [];
        for (const chunk of chunks) {
          if (remaining <= 0) break;
          const excerpt = chunk.excerpt.slice(0, remaining);
          if (!excerpt) continue;
          remaining -= excerpt.length;
          sections.push({
            section_anchor: chunk.section_anchor,
            heading_path: chunk.heading_path,
            excerpt,
            resource_uri: buildVersionUri(projectId, item.id, chunk.version_num, chunk.section_anchor),
          });
          if (remaining <= 0) break;
        }
        if (remaining <= 0) break;
      }

      return {
        canonical_key: input.canonical_key,
        item_id: item.id,
        version_id: version.id,
        version_num: version.version_num,
        max_chars: input.max_chars,
        sections,
      };
    }),

    adminReindexProfile: wrapTool("admin.reindex_profile", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const commitKey = scopedIdempotencyKey("admin.reindex_profile", input.idempotency_key);

      let profileId: string | null = null;
      let profileDims: number | null = null;
      let profileDistance: string | null = null;
      let enqueued = false;

      await withTransaction(pool, async (client) => {
        const commit = await insertOrGetCommit(client, {
          project_id: projectId,
          session_id: null,
          idempotency_key: commitKey,
          author: null,
          summary: "admin.reindex_profile",
        });

        const profile = await getEmbeddingProfileById(
          client,
          projectId,
          input.embedding_profile_id
        );
        if (!profile) {
          throw new NotFoundError("Embedding profile not found", {
            embedding_profile_id: input.embedding_profile_id,
          });
        }

        profileId = profile.id;
        profileDims = profile.dims;
        profileDistance = profile.distance;

        if (commit.deduped) {
          enqueued = false;
          return;
        }

        await enqueueOutboxEvent(client, {
          project_id: projectId,
          event_type: "REINDEX_PROFILE",
          payload: { embedding_profile_id: profile.id },
        });

        enqueued = true;
      });

      if (!profileId || profileDims === null || profileDistance === null) {
        throw new NotFoundError("Embedding profile not found", {
          embedding_profile_id: input.embedding_profile_id,
        });
      }

      // Inline reindex is not executed here; the worker consumes the outbox event.
      await ensureProfileIndex(pool, profileId, profileDims, profileDistance, {
        concurrently: true,
      });

      return {
        embedding_profile_id: profileId,
        enqueued,
      };
    }),
    adminReingestVersion: wrapTool("admin.reingest_version", async (input) => {
      const projectId = resolveProjectId(context, input.project_id);
      const commitKey = scopedIdempotencyKey("admin.reingest_version", input.idempotency_key);

      return withTransaction(pool, async (client) => {
        const commit = await insertOrGetCommit(client, {
          project_id: projectId,
          session_id: null,
          idempotency_key: commitKey,
          author: null,
          summary: "admin.reingest_version",
        });

        const version = await client.query(
          "SELECT id FROM memory_versions WHERE id = $1 AND project_id = $2",
          [input.version_id, projectId]
        );

        if (!version.rows[0]) {
          throw new NotFoundError("Memory version not found", {
            version_id: input.version_id,
          });
        }

        if (commit.deduped) {
          return { version_id: input.version_id, enqueued: false };
        }

        await enqueueOutboxEvent(client, {
          project_id: projectId,
          event_type: "INGEST_VERSION",
          payload: { version_id: input.version_id },
        });

        if (input.include_embedding) {
          await enqueueOutboxEvent(client, {
            project_id: projectId,
            event_type: "EMBED_VERSION",
            payload: { version_id: input.version_id },
          });
        }

        return { version_id: input.version_id, enqueued: true };
      });
    }),
    healthCheck: wrapTool("health.check", async () => {
      const health = await checkDbHealth(pool);
      const backlog = await pool.query(
        "SELECT COUNT(*)::int AS count FROM outbox_events WHERE processed_at IS NULL"
      );
      const activeProfile = await pool.query(
        "SELECT id FROM embedding_profiles WHERE is_active = true ORDER BY created_at DESC LIMIT 1"
      );

      return {
        ok: health.ok,
        database_ok: health.ok,
        worker_backlog: Number(backlog.rows[0]?.count ?? 0),
        active_embedding_profile_id: activeProfile.rows[0]?.id ?? null,
        time: new Date().toISOString(),
      };
    }),
  };
}
