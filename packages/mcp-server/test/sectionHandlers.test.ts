import crypto from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { chunkMarkdown, createMemoryVersion, createPool, upsertCanonicalDoc } from "@memento/core";
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

describe("canonical section handlers", () => {
  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("returns outline and section text", async () => {
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

    const markdown = "# Overview\nIntro\n\n## Setup\nDetails\n";
    const version = await createMemoryVersion(pool, {
      project_id: resolved.project_id,
      item_id: canonical.item.id,
      commit_id: null,
      content_format: "markdown",
      content_text: markdown,
      checksum: crypto.createHash("sha256").update(markdown).digest("hex"),
    });

    const chunks = chunkMarkdown(markdown);
    for (const chunk of chunks) {
      await pool.query(
        `INSERT INTO memory_chunks (
           version_id, chunk_index, chunk_text, heading_path, section_anchor, start_char, end_char, tsv
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_tsvector('english', $3))`,
        [
          version.id,
          chunk.chunk_index,
          chunk.chunk_text,
          chunk.heading_path,
          chunk.section_anchor,
          chunk.start_char,
          chunk.end_char,
        ]
      );
    }

    const outlineResult = await handlers.canonicalOutline({
      canonical_key: canonicalKey,
    });

    const outline = outlineResult.structuredContent as {
      sections: Array<{ section_anchor: string; heading_path: string[] }>;
    };

    const setupSection = outline.sections.find((section) => section.section_anchor.includes("setup"));
    expect(setupSection).toBeTruthy();

    const sectionResult = await handlers.canonicalGetSection({
      canonical_key: canonicalKey,
      section_anchor: setupSection?.section_anchor ?? "",
      max_chars: 2000,
    });

    const section = sectionResult.structuredContent as { text: string; truncated: boolean };
    expect(section.text).toContain("Setup");
    expect(section.truncated).toBe(false);
  });
});
