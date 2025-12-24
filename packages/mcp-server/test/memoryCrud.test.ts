import crypto from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@memento/core";
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

describe("canonical + memory CRUD handlers", () => {
  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("creates canonical docs and manages memory CRUD operations", async () => {
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

    const canonicalResult = await handlers.canonicalUpsert({
      canonical_key: "app",
      doc_class: "app_spec",
      title: "MyApp Spec",
      content: { format: "markdown", text: "# Spec v1" },
      idempotency_key: uniqueName("canonical"),
    });

    const canonical = canonicalResult.structuredContent as {
      item_id: string;
      version_id: string;
      version_num: number;
      canonical_key: string;
    };

    expect(canonical.canonical_key).toBe("app");

    const outbox = await pool.query(
      "SELECT event_type FROM outbox_events WHERE project_id = $1 AND payload->>'version_id' = $2",
      [resolved.project_id, canonical.version_id]
    );
    const types = outbox.rows.map((row) => row.event_type);
    expect(types).toContain("INGEST_VERSION");
    expect(types).toContain("EMBED_VERSION");

    const commitResult = await handlers.memoryCommit({
      idempotency_key: uniqueName("commit"),
      entries: [
        {
          kind: "note",
          scope: "project",
          title: "Note One",
          content: { format: "markdown", text: "Note content" },
          links: [
            {
              to: { canonical_key: "app" },
              relation: "references",
              weight: 1.0,
              metadata: {},
            },
          ],
        },
      ],
    });

    const commit = commitResult.structuredContent as {
      commit_id: string;
      deduped: boolean;
      results: Array<{ item_id: string; version_id: string; version_num: number }>;
    };

    expect(commit.deduped).toBe(false);
    expect(commit.results.length).toBe(1);

    const itemId = commit.results[0].item_id;

    const getResult = await handlers.memoryGet({ item_id: itemId, max_chars: 1000 });
    const getPayload = getResult.structuredContent as {
      item: { item_id: string; title: string };
      version?: { version_id: string };
    };
    expect(getPayload.item.item_id).toBe(itemId);
    expect(getPayload.version).toBeTruthy();

    const pinResult = await handlers.memoryPin({
      item_id: itemId,
      idempotency_key: uniqueName("pin"),
    });
    expect((pinResult.structuredContent as { pinned: boolean }).pinned).toBe(true);

    const unpinResult = await handlers.memoryUnpin({
      item_id: itemId,
      idempotency_key: uniqueName("unpin"),
    });
    expect((unpinResult.structuredContent as { pinned: boolean }).pinned).toBe(false);

    const archiveResult = await handlers.memoryArchive({
      item_id: itemId,
      status: "archived",
      idempotency_key: uniqueName("archive"),
    });
    expect((archiveResult.structuredContent as { status: string }).status).toBe("archived");

    const historyResult = await handlers.memoryHistory({
      canonical_key: "app",
      limit: 10,
      offset: 0,
    });
    const history = historyResult.structuredContent as { versions: Array<unknown> };
    expect(history.versions.length).toBeGreaterThan(0);

    const linkResult = await handlers.memoryLink({
      idempotency_key: uniqueName("link"),
      from: { item_id: itemId },
      to: { canonical_key: "app" },
      relation: "references",
      weight: 1.0,
      metadata: {},
    });
    expect((linkResult.structuredContent as { link_id: string }).link_id).toBeTruthy();
  });
});
