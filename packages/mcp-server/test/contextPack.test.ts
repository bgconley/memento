import crypto from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createMemoryVersion,
  createPool,
  upsertCanonicalDoc,
  upsertMemoryItem,
} from "@memento/core";
import { createHandlers } from "../src/handlers";
import { createRequestContext } from "../src/context";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for mcp-server tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

let workspaceId: string | null = null;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("context pack handlers", () => {
  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("builds restore and canonical context packs within limits", async () => {
    const context = createRequestContext();
    const handlers = createHandlers({ pool, context });

    const resolveResult = await handlers.projectsResolve({
      workspace_name: uniqueName("workspace"),
      repo_url: `https://example.com/${crypto.randomUUID()}.git`,
      cwd: "/tmp/memento",
      create_if_missing: true,
    });

    const resolved = resolveResult.structuredContent as {
      workspace_id: string;
      project_id: string;
    };

    workspaceId = resolved.workspace_id;

    const canonicalKey = `spec/${crypto.randomUUID()}`;
    const canonical = await upsertCanonicalDoc(pool, {
      project_id: resolved.project_id,
      canonical_key: canonicalKey,
      doc_class: "app_spec",
      title: "Spec",
      kind: "spec",
      scope: "project",
    });

    const canonicalText = "# API\n\nConnection reset behavior.";
    const canonicalVersion = await createMemoryVersion(pool, {
      project_id: resolved.project_id,
      item_id: canonical.item.id,
      commit_id: null,
      content_format: "markdown",
      content_text: canonicalText,
      checksum: crypto.createHash("sha256").update(canonicalText).digest("hex"),
    });

    await pool.query(
      `INSERT INTO memory_chunks (version_id, chunk_index, chunk_text, section_anchor, heading_path, tsv)
       VALUES ($1, 0, $2, $3, $4, to_tsvector('english', $2))`,
      [canonicalVersion.id, canonicalText, "api", ["API"]]
    );

    const troubleshooting = await upsertMemoryItem(pool, {
      project_id: resolved.project_id,
      scope: "project",
      kind: "troubleshooting",
      title: "Reset issue",
      tags: [],
      metadata: {},
    });

    const troubleText = "Error ECONNRESET_42 on reset";
    const troubleVersion = await createMemoryVersion(pool, {
      project_id: resolved.project_id,
      item_id: troubleshooting.id,
      commit_id: null,
      content_format: "markdown",
      content_text: troubleText,
      checksum: crypto.createHash("sha256").update(troubleText).digest("hex"),
    });

    await pool.query(
      `INSERT INTO memory_chunks (version_id, chunk_index, chunk_text, tsv)
       VALUES ($1, 0, $2, to_tsvector('english', $2))`,
      [troubleVersion.id, troubleText]
    );

    const restoreResult = await handlers.memoryRestore({
      goal: "ECONNRESET_42",
      max_items: 5,
      max_chars: 2000,
      include_latest_snapshot: false,
      include_context_pack: true,
    });

    const restore = restoreResult.structuredContent as {
      context_pack?: { max_chars: number; sections: Array<{ excerpt: string; resource_uri: string }> };
    };

    expect(restore.context_pack).toBeTruthy();
    const totalChars = restore.context_pack?.sections.reduce((sum, section) => sum + section.excerpt.length, 0) ?? 0;
    expect(totalChars).toBeLessThanOrEqual(2000);
    expect(restore.context_pack?.sections[0].resource_uri).toContain("memory://projects/");

    const contextPackResult = await handlers.canonicalContextPack({
      canonical_key: canonicalKey,
      goal: "connection reset",
      max_chars: 2000,
    });

    const contextPack = contextPackResult.structuredContent as {
      canonical_key: string;
      sections: Array<{ excerpt: string; resource_uri: string }>;
    };

    expect(contextPack.canonical_key).toBe(canonicalKey);
    expect(contextPack.sections.length).toBeGreaterThan(0);
    expect(contextPack.sections[0].resource_uri).toContain("#");
  });
});
