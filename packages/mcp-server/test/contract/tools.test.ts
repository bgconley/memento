import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHandlers } from "../../src/handlers";
import { createRequestContext } from "../../src/context";
import { ToolSchemas } from "@memento/shared";
import { chunkMarkdown, createPool, normalizeMarkdown } from "@memento/core";
import {
  loadJson,
  normalizeOutput,
  resolveFixturePath,
  resolveGoldenPath,
} from "./utils";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for mcp-server contract tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function ingestVersion(versionId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, project_id, content_text, content_json, content_format
     FROM memory_versions
     WHERE id = $1`,
    [versionId]
  );

  const version = rows[0];
  if (!version) {
    throw new Error(`Missing version ${versionId}`);
  }

  const markdown = normalizeMarkdown({
    format: version.content_format,
    text: version.content_text,
    json: version.content_json,
  });

  const chunks = chunkMarkdown(markdown);

  await pool.query("DELETE FROM memory_chunks WHERE version_id = $1", [versionId]);

  for (const chunk of chunks) {
    await pool.query(
      `INSERT INTO memory_chunks (
        project_id,
        version_id,
        chunk_index,
        chunk_text,
        heading_path,
        section_anchor,
        start_char,
        end_char,
        tsv
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_tsvector('english', $4))`,
      [
        version.project_id,
        versionId,
        chunk.chunk_index,
        chunk.chunk_text,
        chunk.heading_path,
        chunk.section_anchor,
        chunk.start_char,
        chunk.end_char,
      ]
    );
  }
}

describe.sequential("tool contract snapshots", () => {
  let workspaceId: string | null = null;
  const context = createRequestContext();
  const handlers = createHandlers({ pool, context });

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("projects.resolve output matches golden", async () => {
    const input = loadJson<Record<string, unknown>>(resolveFixturePath("projects.resolve.json"));
    const result = await handlers.projectsResolve({
      ...input,
      workspace_name: uniqueName("workspace"),
    });

    const parsed = ToolSchemas["projects.resolve"].output.parse(result.structuredContent);
    const normalized = normalizeOutput(parsed);
    const expected = loadJson(resolveGoldenPath("projects.resolve.expected.json"));

    workspaceId = parsed.workspace_id;

    expect(normalized).toEqual(expected);
  });

  it("canonical.upsert output matches golden", async () => {
    const input = loadJson<Record<string, unknown>>(resolveFixturePath("canonical.upsert.app.json"));
    const result = await handlers.canonicalUpsert(input);

    const parsed = ToolSchemas["canonical.upsert"].output.parse(result.structuredContent);
    const normalized = normalizeOutput(parsed);
    const expected = loadJson(resolveGoldenPath("canonical.upsert.app.expected.json"));

    await ingestVersion(parsed.version_id);

    expect(normalized).toEqual(expected);
  });

  it("memory.restore output matches golden", async () => {
    const input = loadJson<Record<string, unknown>>(resolveFixturePath("memory.restore.goal.json"));
    const result = await handlers.memoryRestore(input);

    const parsed = ToolSchemas["memory.restore"].output.parse(result.structuredContent);
    const normalized = normalizeOutput(parsed);
    const expected = loadJson(resolveGoldenPath("memory.restore.goal.expected.json"));

    expect(normalized).toEqual(expected);
  });
});
