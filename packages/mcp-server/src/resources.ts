import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Pool } from "pg";
import { getLatestMemoryVersion, getMemoryItemById, getMemoryVersion } from "@memento/core";
import { resolveProjectId, type RequestContext } from "./context";

type ResourceDeps = {
  pool: Pool;
  context: RequestContext;
};

type ResourceRow = {
  id: string;
  title: string;
  kind: string;
  canonical_key: string | null;
  pinned: boolean;
  updated_at: string;
};

const MAX_RESOURCE_ITEMS = 50;

function buildItemUri(projectId: string, itemId: string): string {
  return `memory://projects/${projectId}/items/${itemId}`;
}

function requireStringVar(value: string | string[], name: string): string {
  const resolved = Array.isArray(value) ? value[0] : value;
  if (!resolved) {
    throw new McpError(ErrorCode.InvalidParams, `Missing URI variable: ${name}`);
  }
  return resolved;
}

function requireProjectId(context: RequestContext): string {
  try {
    return resolveProjectId(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : "project_id is required";
    throw new McpError(ErrorCode.InvalidParams, message);
  }
}

function assertProjectMatch(context: RequestContext, projectId: string): string {
  let activeProjectId: string;
  try {
    activeProjectId = resolveProjectId(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : "project_id is required";
    throw new McpError(ErrorCode.InvalidParams, message);
  }
  if (projectId !== activeProjectId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `project_id mismatch: expected ${activeProjectId}, got ${projectId}`
    );
  }
  return activeProjectId;
}
async function listItemResources(pool: Pool, projectId: string) {
  const result = await pool.query<ResourceRow>(
    `SELECT id, title, kind, canonical_key, pinned, updated_at
     FROM memory_items
     WHERE project_id = $1 AND status = 'active'
     ORDER BY pinned DESC, updated_at DESC
     LIMIT $2`,
    [projectId, MAX_RESOURCE_ITEMS]
  );

  return result.rows.map((row) => ({
    uri: buildItemUri(projectId, row.id),
    name: row.title,
    description: row.canonical_key ? `${row.kind} (${row.canonical_key})` : row.kind,
    mimeType: "text/markdown",
  }));
}

async function readItemLatest(pool: Pool, projectId: string, itemId: string) {
  const item = await getMemoryItemById(pool, projectId, itemId);
  if (!item) {
    throw new McpError(ErrorCode.InvalidParams, `Item not found: ${itemId}`);
  }

  const version = await getLatestMemoryVersion(pool, projectId, itemId);
  if (!version) {
    throw new McpError(ErrorCode.InvalidParams, `No versions for item: ${itemId}`);
  }

  return {
    contents: [
      {
        uri: buildItemUri(projectId, itemId),
        mimeType: "text/markdown",
        text: version.content_text ?? "",
      },
    ],
  };
}

async function readItemVersion(
  pool: Pool,
  projectId: string,
  itemId: string,
  versionNum: number
) {
  const item = await getMemoryItemById(pool, projectId, itemId);
  if (!item) {
    throw new McpError(ErrorCode.InvalidParams, `Item not found: ${itemId}`);
  }

  const version = await getMemoryVersion(pool, projectId, itemId, versionNum);

  return {
    contents: [
      {
        uri: `memory://projects/${projectId}/items/${itemId}/versions/${versionNum}`,
        mimeType: "text/markdown",
        text: version.content_text ?? "",
      },
    ],
  };
}
async function readItemSection(
  pool: Pool,
  projectId: string,
  itemId: string,
  sectionAnchor: string
) {
  const item = await getMemoryItemById(pool, projectId, itemId);
  if (!item) {
    throw new McpError(ErrorCode.InvalidParams, `Item not found: ${itemId}`);
  }

  const version = await getLatestMemoryVersion(pool, projectId, itemId);
  if (!version) {
    throw new McpError(ErrorCode.InvalidParams, `No versions for item: ${itemId}`);
  }

  type SectionChunkRow = {
    chunk_index: number;
    chunk_text: string;
    heading_path: string[] | null;
    section_anchor: string | null;
    start_char: number | null;
    end_char: number | null;
  };

  const chunkRows = await pool.query<SectionChunkRow>(
    `SELECT chunk_index, chunk_text, heading_path, section_anchor, start_char, end_char
     FROM memory_chunks
     WHERE version_id = $1 AND section_anchor = $2
     ORDER BY chunk_index ASC`,
    [version.id, sectionAnchor]
  );

  if (chunkRows.rows.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, `Section not found: ${sectionAnchor}`);
  }

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

  return {
    contents: [
      {
        uri: `memory://projects/${projectId}/items/${itemId}/sections/${encodeURIComponent(sectionAnchor)}`,
        mimeType: "text/markdown",
        text,
      },
    ],
  };
}
export function registerResources(server: McpServer, deps: ResourceDeps) {
  const { pool, context } = deps;

  const itemTemplate = new ResourceTemplate("memory://projects/{project_id}/items/{item_id}", {
    list: async () => {
      const projectId = requireProjectId(context);
      return { resources: await listItemResources(pool, projectId) };
    },
  });

  server.registerResource(
    "memory-item",
    itemTemplate,
    { title: "Memory Item", mimeType: "text/markdown" },
    async (_uri, variables) => {
      const projectId = assertProjectMatch(context, requireStringVar(variables.project_id, "project_id"));
      const itemId = requireStringVar(variables.item_id, "item_id");
      return readItemLatest(pool, projectId, itemId);
    }
  );

  const itemVersionTemplate = new ResourceTemplate(
    "memory://projects/{project_id}/items/{item_id}/versions/{version_num}",
    { list: undefined }
  );

  server.registerResource(
    "memory-item-version",
    itemVersionTemplate,
    { title: "Memory Item Version", mimeType: "text/markdown" },
    async (_uri, variables) => {
      const projectId = assertProjectMatch(context, requireStringVar(variables.project_id, "project_id"));
      const itemId = requireStringVar(variables.item_id, "item_id");
      const rawVersion = requireStringVar(variables.version_num, "version_num");
      const versionNum = Number(rawVersion);
      if (!Number.isInteger(versionNum) || versionNum <= 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "version_num must be a positive integer"
        );
      }
      return readItemVersion(pool, projectId, itemId, versionNum);
    }
  );

  const sectionTemplate = new ResourceTemplate(
    "memory://projects/{project_id}/items/{item_id}/sections/{section_anchor}",
    { list: undefined }
  );

  server.registerResource(
    "memory-item-section",
    sectionTemplate,
    { title: "Memory Item Section", mimeType: "text/markdown" },
    async (_uri, variables) => {
      const projectId = assertProjectMatch(context, requireStringVar(variables.project_id, "project_id"));
      const itemId = requireStringVar(variables.item_id, "item_id");
      const sectionAnchor = decodeURIComponent(requireStringVar(variables.section_anchor, "section_anchor"));
      return readItemSection(pool, projectId, itemId, sectionAnchor);
    }
  );
}
