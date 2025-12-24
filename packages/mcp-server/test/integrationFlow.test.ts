import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHandlers } from "../src/handlers";
import { createRequestContext } from "../src/context";
import { createPool, semanticSearch, hybridSearch } from "@memento/core";
import { createJobHandlers, pollOutboxOnce } from "../../worker/src/outboxPoller";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for integration flow tests");
}

process.env.EMBEDDER_USE_FAKE = "1";

const pool = createPool({ connectionString: DATABASE_URL });

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function drainOutbox(projectId: string): Promise<void> {
  const handlers = createJobHandlers();
  for (let i = 0; i < 50; i += 1) {
    const result = await pollOutboxOnce(pool, handlers, { batchSize: 5, projectId });
    if (result.processed === 0 && result.errors === 0) return;
    if (result.processed === 0 && result.errors > 0) {
      throw new Error("Outbox stalled with errors");
    }
  }
  throw new Error("Outbox did not drain");
}

describe.sequential("integration flow", () => {
  const context = createRequestContext();
  const handlers = createHandlers({ pool, context });

  let workspaceId: string | null = null;
  let projectId: string | null = null;
  let canonicalKey: string | null = null;
  let troubleshootingItemId: string | null = null;

  beforeAll(async () => {
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
    projectId = resolved.project_id;

    await handlers.embeddingProfilesUpsert({
      idempotency_key: `embed-${crypto.randomUUID()}`,
      name: "fake-embeddings",
      provider: "openai_compat",
      model: "fake-embedding",
      dims: 8,
      distance: "cosine",
      provider_config: { use_fake: true },
      set_active: true,
    });
  });

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("canonical.upsert -> ingest -> outline/get_section", async () => {
    if (!projectId) throw new Error("projectId missing");

    canonicalKey = `spec/${crypto.randomUUID()}`;

    const canonicalResult = await handlers.canonicalUpsert({
      idempotency_key: `canon-${crypto.randomUUID()}`,
      canonical_key: canonicalKey,
      doc_class: "app_spec",
      title: "MyApp — Application Specification",
      tags: ["canonical"],
      content: {
        format: "markdown",
        text: [
          "# MyApp",
          "",
          "## Auth",
          "Token refresh uses rotating refresh tokens.",
          "",
          "## Troubleshooting",
          "If ECONNRESET_42 occurs, retry the request.",
        ].join("\n"),
      },
    });

    const canonicalOutput = canonicalResult.structuredContent as {
      version_id: string;
    };

    await drainOutbox(projectId);

    const outlineResult = await handlers.canonicalOutline({
      canonical_key: canonicalKey,
    });

    const outline = outlineResult.structuredContent as {
      sections: Array<{ section_anchor: string; heading_path: string[] }>;
    };

    const authSection = outline.sections.find((section) =>
      section.heading_path.includes("Auth")
    );

    expect(authSection).toBeTruthy();

    const sectionResult = await handlers.canonicalGetSection({
      canonical_key: canonicalKey,
      section_anchor: authSection?.section_anchor ?? "",
      max_chars: 2000,
    });

    const section = sectionResult.structuredContent as { text: string };
    expect(section.text).toContain("Token refresh uses");

    expect(canonicalOutput.version_id).toBeTruthy();
  });

  it("troubleshooting entry hits lexical search", async () => {
    if (!projectId) throw new Error("projectId missing");

    const commitResult = await handlers.memoryCommit({
      idempotency_key: `trouble-${crypto.randomUUID()}`,
      entries: [
        {
          kind: "troubleshooting",
          scope: "project",
          title: "Reset issue",
          content: {
            format: "markdown",
            text: "Encountered ECONNRESET_42 while testing token refresh.",
          },
        },
      ],
    });

    const commitOutput = commitResult.structuredContent as {
      results: Array<{ item_id: string }>;
    };

    troubleshootingItemId = commitOutput.results[0]?.item_id ?? null;

    await drainOutbox(projectId);

    const searchResult = await handlers.memorySearch({
      query: "ECONNRESET_42",
      lexical_top_k: 10,
      semantic_top_k: 5,
    });

    const search = searchResult.structuredContent as {
      results: Array<{ item: { item_id: string; kind: string }; best_chunks?: Array<{ excerpt: string }> }>;
    };

    const match = search.results.find((result) => result.item.kind === "troubleshooting");
    expect(match).toBeTruthy();
    expect(match?.best_chunks?.[0]?.excerpt).toContain("ECONNRESET_42");
  });

  it("semantic search hits canonical content with fake embedder", async () => {
    if (!projectId) throw new Error("projectId missing");
    if (!canonicalKey) throw new Error("canonicalKey missing");

    const result = await semanticSearch(pool, {
      project_id: projectId,
      query: "refresh tokens and retry logic",
      filters: { canonical_only: true },
      options: { top_k: 5, max_chunk_chars: 200 },
    });

    const hasCanonical = result.matches.some((match) => match.canonical_key === canonicalKey);
    expect(hasCanonical).toBe(true);
  });

  it("hybrid fusion keeps lexical hits", async () => {
    if (!projectId) throw new Error("projectId missing");
    if (!troubleshootingItemId) throw new Error("troubleshooting item missing");

    const result = await hybridSearch(pool, {
      project_id: projectId,
      query: "ECONNRESET_42 token refresh",
      filters: {},
      options: {
        lexical_top_k: 10,
        semantic_top_k: 10,
        include_chunks: true,
        max_chunk_chars: 200,
      },
    });

    const itemIds = result.results.map((entry) => entry.item.item_id);
    expect(itemIds).toContain(troubleshootingItemId);
  });
});
