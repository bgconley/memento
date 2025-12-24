import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db";
import { getOrCreateWorkspace } from "../../src/repos/workspaces";
import { resolveProject } from "../../src/repos/projects";
import { upsertCanonicalDoc } from "../../src/repos/canonicalDocs";
import { upsertMemoryItem } from "../../src/repos/memoryItems";
import { createMemoryVersion, getLatestMemoryVersion } from "../../src/repos/memoryVersions";
import { createMemoryLink } from "../../src/repos/memoryLinks";
import { enqueueOutboxEvent, pollOutboxEvents } from "../../src/repos/outbox";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for repo tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

let workspaceId: string | null = null;
let projectId: string | null = null;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("memory repos", () => {
  beforeAll(async () => {
    const workspace = await getOrCreateWorkspace(pool, uniqueName("workspace"));
    workspaceId = workspace.id;

    const project = await resolveProject(pool, {
      workspace_id: workspace.id,
      repo_url: `https://example.com/${crypto.randomUUID()}.git`,
      cwd: null,
      project_key: null,
      display_name: null,
      create_if_missing: true,
    });
    projectId = project.id;
  });

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("creates canonical docs, versions, links, and outbox events", async () => {
    if (!projectId) throw new Error("project_id missing");

    const canonicalKey = `spec/${crypto.randomUUID()}`;
    const canonical = await upsertCanonicalDoc(pool, {
      project_id: projectId,
      canonical_key: canonicalKey,
      doc_class: "app_spec",
      title: "App Spec",
      kind: "spec",
      scope: "project",
    });

    expect(canonical.item.project_id).toBe(projectId);
    expect(canonical.item.pinned).toBe(true);
    expect(canonical.canonical.canonical_key).toBe(canonicalKey);

    const version1 = await createMemoryVersion(pool, {
      project_id: projectId,
      item_id: canonical.item.id,
      content_format: "markdown",
      content_text: "# Spec v1",
      checksum: crypto.createHash("sha256").update("v1").digest("hex"),
    });

    const version2 = await createMemoryVersion(pool, {
      project_id: projectId,
      item_id: canonical.item.id,
      content_format: "markdown",
      content_text: "# Spec v2",
      checksum: crypto.createHash("sha256").update("v2").digest("hex"),
    });

    expect(version2.version_num).toBe(version1.version_num + 1);

    const latest = await getLatestMemoryVersion(pool, projectId, canonical.item.id);
    expect(latest?.version_num).toBe(version2.version_num);

    const secondaryItem = await upsertMemoryItem(pool, {
      project_id: projectId,
      scope: "project",
      kind: "note",
      title: "Note",
    });

    const link = await createMemoryLink(pool, {
      project_id: projectId,
      from_item_id: canonical.item.id,
      to_item_id: secondaryItem.id,
      relation: "references",
    });

    expect(link.project_id).toBe(projectId);
    expect(link.from_item_id).toBe(canonical.item.id);

    const event = await enqueueOutboxEvent(pool, {
      project_id: projectId,
      event_type: "INGEST_VERSION",
      payload: { version_id: version2.id },
    });

    const events = await pollOutboxEvents(pool, { project_id: projectId, limit: 10 });
    expect(events.find((row) => row.id === event.id)).toBeTruthy();
  });
});
