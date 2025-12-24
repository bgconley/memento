import crypto from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildProfileIndexName, createPool } from "@memento/core";
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

async function indexExists(indexName: string) {
  const result = await pool.query(
    "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
    [indexName]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

describe("embedding profile handlers", () => {
  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("upserts profiles, ensures indexes, and activates only one", async () => {
    const skipIndexBuild =
      process.env.MEMENTO_SKIP_INDEX_BUILD === "1" ||
      process.env.MEMENTO_SKIP_INDEX_BUILD === "true";
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

    const upsertAResult = await handlers.embeddingProfilesUpsert({
      idempotency_key: uniqueName("profile-a"),
      name: uniqueName("profile-a"),
      provider: "voyage",
      model: "voyage-3",
      dims: 8,
      distance: "cosine",
      provider_config: {},
      set_active: false,
    });

    const upsertA = upsertAResult.structuredContent as {
      embedding_profile_id: string;
      created: boolean;
      index_created: boolean;
    };

    expect(upsertA.created).toBe(true);
    expect(upsertA.index_created).toBe(!skipIndexBuild);

    const indexNameA = buildProfileIndexName(upsertA.embedding_profile_id);
    if (!skipIndexBuild) {
      expect(await indexExists(indexNameA)).toBe(true);
    }

    const upsertBResult = await handlers.embeddingProfilesUpsert({
      idempotency_key: uniqueName("profile-b"),
      name: uniqueName("profile-b"),
      provider: "jina",
      model: "jina-embeddings-v3",
      dims: 8,
      distance: "cosine",
      provider_config: {},
      set_active: false,
    });

    const upsertB = upsertBResult.structuredContent as {
      embedding_profile_id: string;
      created: boolean;
      index_created: boolean;
    };

    expect(upsertB.created).toBe(true);
    expect(upsertB.index_created).toBe(!skipIndexBuild);

    const indexNameB = buildProfileIndexName(upsertB.embedding_profile_id);
    if (!skipIndexBuild) {
      expect(await indexExists(indexNameB)).toBe(true);
    }

    const activateAResult = await handlers.embeddingProfilesActivate({
      embedding_profile_id: upsertA.embedding_profile_id,
      idempotency_key: uniqueName("activate-a"),
    });

    expect((activateAResult.structuredContent as { activated: boolean }).activated).toBe(true);

    const listAfterAResult = await handlers.embeddingProfilesList({ include_inactive: true });
    const listAfterA = listAfterAResult.structuredContent as {
      profiles: Array<{ embedding_profile_id: string; is_active: boolean }>;
    };

    const aProfile = listAfterA.profiles.find(
      (profile) => profile.embedding_profile_id === upsertA.embedding_profile_id
    );
    const bProfile = listAfterA.profiles.find(
      (profile) => profile.embedding_profile_id === upsertB.embedding_profile_id
    );

    expect(aProfile?.is_active).toBe(true);
    expect(bProfile?.is_active).toBe(false);

    const activateBResult = await handlers.embeddingProfilesActivate({
      embedding_profile_id: upsertB.embedding_profile_id,
      idempotency_key: uniqueName("activate-b"),
    });

    expect((activateBResult.structuredContent as { activated: boolean }).activated).toBe(true);

    const listAfterBResult = await handlers.embeddingProfilesList({ include_inactive: true });
    const listAfterB = listAfterBResult.structuredContent as {
      profiles: Array<{ embedding_profile_id: string; is_active: boolean }>;
    };

    const aProfileAfter = listAfterB.profiles.find(
      (profile) => profile.embedding_profile_id === upsertA.embedding_profile_id
    );
    const bProfileAfter = listAfterB.profiles.find(
      (profile) => profile.embedding_profile_id === upsertB.embedding_profile_id
    );

    expect(aProfileAfter?.is_active).toBe(false);
    expect(bProfileAfter?.is_active).toBe(true);
  });
});
