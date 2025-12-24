import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embedder";
import { VoyageEmbedder } from "../src/voyage";
import { JinaEmbedder } from "../src/jina";
import { OpenAICompatEmbedder } from "../src/openaiCompat";

type FetchArgs = { url: string; body: unknown; headers: Record<string, string> };

let lastFetch: FetchArgs | null = null;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  lastFetch = null;
});

function mockFetch(responseBody: unknown) {
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body.toString()) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    lastFetch = { url, body, headers };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("FakeEmbedder", () => {
  it("returns deterministic vectors", async () => {
    const embedder = new FakeEmbedder({ dims: 4 });
    const result = await embedder.embed({ texts: ["hello"], inputType: "query" });
    expect(result.vectors[0]).toEqual(await embedder.embed({ texts: ["hello"], inputType: "query" }).then(r => r.vectors[0]));
    expect(result.vectors[0].length).toBe(4);
  });
});

describe("VoyageEmbedder", () => {
  it("sends voyage payload", async () => {
    mockFetch({ data: [{ embedding: [0.1, 0.2] }] });
    const embedder = new VoyageEmbedder({
      baseUrl: "https://api.voyageai.com",
      apiKey: "test",
      model: "voyage-3",
      dims: 2,
    });

    const result = await embedder.embed({ texts: ["hello"], inputType: "query" });
    expect(result.vectors[0]).toEqual([0.1, 0.2]);
    expect(lastFetch?.url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(lastFetch?.body).toMatchObject({
      input: ["hello"],
      model: "voyage-3",
      input_type: "query",
      output_dimension: 2,
    });
  });
});

describe("JinaEmbedder", () => {
  it("sends jina payload", async () => {
    mockFetch({ data: [{ embedding: [0.5, 0.6] }] });
    const embedder = new JinaEmbedder({
      baseUrl: "https://api.jina.ai",
      apiKey: "test",
      model: "jina-embeddings-v3",
      dims: 2,
    });

    const result = await embedder.embed({ texts: ["hello"], inputType: "passage" });
    expect(result.vectors[0]).toEqual([0.5, 0.6]);
    expect(lastFetch?.url).toBe("https://api.jina.ai/v1/embeddings");
    expect(lastFetch?.body).toMatchObject({
      input: ["hello"],
      model: "jina-embeddings-v3",
      task: "retrieval.passage",
      dimensions: 2,
    });
  });
});

describe("OpenAICompatEmbedder", () => {
  it("sends openai-compat payload", async () => {
    mockFetch({ data: [{ embedding: [0.9, 0.8] }] });
    const embedder = new OpenAICompatEmbedder({
      baseUrl: "http://localhost:8080/v1",
      apiKey: "test",
      model: "local-embed",
      dims: 2,
    });

    const result = await embedder.embed({ texts: ["hello"], inputType: "query" });
    expect(result.vectors[0]).toEqual([0.9, 0.8]);
    expect(lastFetch?.url).toBe("http://localhost:8080/v1/embeddings");
    expect(lastFetch?.body).toMatchObject({
      input: ["hello"],
      model: "local-embed",
      dimensions: 2,
    });
  });
});
