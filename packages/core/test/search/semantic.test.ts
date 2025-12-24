import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmbedder } from "@memento/clients";
import { createPool } from "../../src/db";
import { getOrCreateWorkspace } from "../../src/repos/workspaces";
import { resolveProject } from "../../src/repos/projects";
import { createMemoryVersion } from "../../src/repos/memoryVersions";
import { upsertMemoryItem } from "../../src/repos/memoryItems";
import { activateEmbeddingProfile, upsertEmbeddingProfile } from "../../src/repos/embeddingProfiles";
import { semanticSearch } from "../../src/search/semantic";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for semantic search tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

let workspaceId: string | null = null;
let projectId: string | null = null;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("semantic search", () => {
  beforeAll(async () => {
    process.env.EMBEDDER_USE_FAKE = "true";

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
    delete process.env.EMBEDDER_USE_FAKE;
  });

  it("returns the expected chunk for a paraphrased query", async () => {
    if (!projectId) throw new Error("project_id missing");

    const item = await upsertMemoryItem(pool, {
      project_id: projectId,
      scope: "project",
      kind: "note",
      title: "Reset errors",
      tags: [],
      metadata: {},
    });

    const chunkText = "Connection reset error ECONNRESET_42 while calling service";
    const version = await createMemoryVersion(pool, {
      project_id: projectId,
      item_id: item.id,
      commit_id: null,
      content_format: "markdown",
      content_text: chunkText,
      checksum: crypto.createHash("sha256").update(chunkText).digest("hex"),
    });

    const chunkInsert = await pool.query(
      `INSERT INTO memory_chunks (version_id, chunk_index, chunk_text, tsv)
       VALUES ($1, 0, $2, to_tsvector('english', $2))
       RETURNING id`,
      [version.id, chunkText]
    );
    const chunkId = chunkInsert.rows[0].id as string;

    const { profile } = await upsertEmbeddingProfile(pool, {
      project_id: projectId,
      name: uniqueName("profile"),
      provider: "voyage",
      model: "voyage-3",
      dims: 8,
      distance: "cosine",
      provider_config: { use_fake: true },
    });
    await activateEmbeddingProfile(pool, projectId, profile.id);

    const embedder = new FakeEmbedder({ dims: 8 });
    const vector = (await embedder.embed({ texts: [chunkText], inputType: "passage" })).vectors[0];

    await pool.query(
      `INSERT INTO chunk_embeddings (chunk_id, embedding_profile_id, embedding)
       VALUES ($1, $2, $3::vector)`,
      [chunkId, profile.id, JSON.stringify(vector)]
    );

    const result = await semanticSearch(pool, {
      project_id: projectId,
      query: "ECONNRESET_42 reset connection error",
      options: { top_k: 5, max_chunk_chars: 200 },
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].item_id).toBe(item.id);
    expect(result.profile_id).toBe(profile.id);
  });

  it("applies filters after candidate selection", async () => {
    if (!projectId) throw new Error("project_id missing");

    const targetItem = await upsertMemoryItem(pool, {
      project_id: projectId,
      scope: "project",
      kind: "note",
      title: "Target doc",
      tags: ["target"],
      metadata: {},
    });

    const otherItem = await upsertMemoryItem(pool, {
      project_id: projectId,
      scope: "project",
      kind: "note",
      title: "Other doc",
      tags: ["other"],
      metadata: {},
    });

    const targetText = "Rerank filters should keep this chunk";
    const otherText = "Rerank filters should drop this chunk";

    const targetVersion = await createMemoryVersion(pool, {
      project_id: projectId,
      item_id: targetItem.id,
      commit_id: null,
      content_format: "markdown",
      content_text: targetText,
      checksum: crypto.createHash("sha256").update(targetText).digest("hex"),
    });

    const otherVersion = await createMemoryVersion(pool, {
      project_id: projectId,
      item_id: otherItem.id,
      commit_id: null,
      content_format: "markdown",
      content_text: otherText,
      checksum: crypto.createHash("sha256").update(otherText).digest("hex"),
    });

    const targetChunk = await pool.query(
      `INSERT INTO memory_chunks (version_id, chunk_index, chunk_text, tsv)
       VALUES ($1, 0, $2, to_tsvector('english', $2))
       RETURNING id`,
      [targetVersion.id, targetText]
    );

    const otherChunk = await pool.query(
      `INSERT INTO memory_chunks (version_id, chunk_index, chunk_text, tsv)
       VALUES ($1, 0, $2, to_tsvector('english', $2))
       RETURNING id`,
      [otherVersion.id, otherText]
    );

    const { profile } = await upsertEmbeddingProfile(pool, {
      project_id: projectId,
      name: uniqueName("profile"),
      provider: "voyage",
      model: "voyage-3",
      dims: 8,
      distance: "cosine",
      provider_config: { use_fake: true },
    });
    await activateEmbeddingProfile(pool, projectId, profile.id);

    const embedder = new FakeEmbedder({ dims: 8 });
    const vectors = (await embedder.embed({ texts: [targetText, otherText], inputType: "passage" }))
      .vectors;

    await pool.query(
      `INSERT INTO chunk_embeddings (chunk_id, embedding_profile_id, embedding)
       VALUES ($1, $2, $3::vector), ($4, $2, $5::vector)`,
      [
        targetChunk.rows[0].id,
        profile.id,
        JSON.stringify(vectors[0]),
        otherChunk.rows[0].id,
        JSON.stringify(vectors[1]),
      ]
    );

    const result = await semanticSearch(pool, {
      project_id: projectId,
      query: "filters should keep the target",
      filters: { tags_all: ["target"] },
      options: { top_k: 1, max_chunk_chars: 200 },
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].item_id).toBe(targetItem.id);
  });
});
