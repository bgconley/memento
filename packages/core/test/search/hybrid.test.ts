import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmbedder } from "@memento/clients";
import { createPool } from "../../src/db";
import { getOrCreateWorkspace } from "../../src/repos/workspaces";
import { resolveProject } from "../../src/repos/projects";
import { createMemoryVersion } from "../../src/repos/memoryVersions";
import { upsertMemoryItem } from "../../src/repos/memoryItems";
import { activateEmbeddingProfile, upsertEmbeddingProfile } from "../../src/repos/embeddingProfiles";
import { hybridSearch } from "../../src/search/search";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for hybrid search tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

let workspaceId: string | null = null;
let projectId: string | null = null;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("hybrid search", () => {
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

  it("returns lexical-only and semantic-only hits deterministically", async () => {
    if (!projectId) throw new Error("project_id missing");

    const troubleshooting = await upsertMemoryItem(pool, {
      project_id: projectId,
      scope: "project",
      kind: "troubleshooting",
      title: "Reset issue",
      tags: ["network"],
      metadata: {},
    });

    const troubleshootingText = "Error ECONNRESET_42 when service resets";
    const troubleshootingVersion = await createMemoryVersion(pool, {
      project_id: projectId,
      item_id: troubleshooting.id,
      commit_id: null,
      content_format: "markdown",
      content_text: troubleshootingText,
      checksum: crypto.createHash("sha256").update(troubleshootingText).digest("hex"),
    });

    await pool.query(
      `INSERT INTO memory_chunks (version_id, chunk_index, chunk_text, tsv)
       VALUES ($1, 0, $2, to_tsvector('english', $2))
       RETURNING id`,
      [troubleshootingVersion.id, troubleshootingText]
    );

    const spec = await upsertMemoryItem(pool, {
      project_id: projectId,
      scope: "project",
      kind: "spec",
      title: "API Spec",
      tags: ["spec"],
      metadata: {},
      pinned: true,
      canonical_key: `spec/${crypto.randomUUID()}`,
    });

    const specText = "The service returns connection reset errors for idle sockets";
    const specVersion = await createMemoryVersion(pool, {
      project_id: projectId,
      item_id: spec.id,
      commit_id: null,
      content_format: "markdown",
      content_text: specText,
      checksum: crypto.createHash("sha256").update(specText).digest("hex"),
    });

    const specChunk = await pool.query(
      `INSERT INTO memory_chunks (version_id, chunk_index, chunk_text, tsv)
       VALUES ($1, 0, $2, to_tsvector('english', $2))
       RETURNING id`,
      [specVersion.id, specText]
    );
    const specChunkId = specChunk.rows[0].id as string;

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
    const specVector = (await embedder.embed({ texts: [specText], inputType: "passage" })).vectors[0];

    await pool.query(
      `INSERT INTO chunk_embeddings (chunk_id, embedding_profile_id, embedding)
       VALUES ($1, $2, $3::vector)`,
      [specChunkId, profile.id, JSON.stringify(specVector)]
    );

    const lexicalResult = await hybridSearch(pool, {
      project_id: projectId,
      query: "ECONNRESET_42",
      filters: { kinds: ["troubleshooting"] },
      options: {
        lexical_top_k: 10,
        semantic_top_k: 10,
        include_chunks: true,
        max_chunk_chars: 200,
      },
    });

    expect(lexicalResult.results[0].item.item_id).toBe(troubleshooting.id);

    const semanticResult = await hybridSearch(pool, {
      project_id: projectId,
      query: "paraphrased query without lexical match",
      filters: { kinds: ["spec"] },
      options: {
        lexical_top_k: 5,
        semantic_top_k: 5,
        include_chunks: true,
        max_chunk_chars: 200,
      },
    });

    expect(semanticResult.results[0].item.item_id).toBe(spec.id);

    const mixedResult = await hybridSearch(pool, {
      project_id: projectId,
      query: "ECONNRESET_42 reset connection",
      options: {
        lexical_top_k: 10,
        semantic_top_k: 10,
        include_chunks: true,
        max_chunk_chars: 200,
      },
    });

    const itemIds = mixedResult.results.map((entry) => entry.item.item_id);
    expect(itemIds).toContain(troubleshooting.id);
    expect(itemIds).toContain(spec.id);
  });
});
