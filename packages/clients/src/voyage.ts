import {
  DEFAULT_RETRY_OPTIONS,
  Embedder,
  EmbedRequest,
  EmbedResponse,
  EmbedderConfigBase,
  fetchJson,
  normalizeBaseUrl,
} from "./embedder";

export type VoyageConfig = EmbedderConfigBase;

type VoyageEmbedding = { embedding: number[] };

type VoyageResponse = {
  data: VoyageEmbedding[];
  usage?: { total_tokens?: number };
};

type VoyageContextualResult = {
  embeddings: number[][];
};

type VoyageContextualEmbedding = {
  embedding: number[];
  index?: number;
  object?: string;
};

type VoyageContextualList = {
  data?: VoyageContextualEmbedding[];
  index?: number;
  object?: string;
};

type VoyageContextualResponse = {
  results?: VoyageContextualResult[];
  data?: VoyageContextualList[];
  usage?: { total_tokens?: number };
};

export class VoyageEmbedder implements Embedder {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly dims?: number;
  private readonly retry;
  private readonly fetcher;
  private readonly useContextual;

  constructor(config: VoyageConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dims = config.dims;
    this.retry = config.retry ?? DEFAULT_RETRY_OPTIONS;
    this.fetcher = config.fetcher;
    this.useContextual = this.model.startsWith("voyage-context-");
  }

  static fromEnv(): VoyageEmbedder {
    const baseUrl = process.env.VOYAGE_BASE_URL ?? "https://api.voyageai.com";
    const apiKey = process.env.VOYAGE_API_KEY;
    const model = process.env.VOYAGE_MODEL ?? "voyage-3";
    const dims = process.env.VOYAGE_DIMS ? Number(process.env.VOYAGE_DIMS) : undefined;

    return new VoyageEmbedder({ baseUrl, apiKey, model, dims });
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    if (this.useContextual) {
      const inputType = request.inputType === "query" ? "query" : "document";
      return this.embedContextual(request.texts.map((text) => [text]), inputType);
    }

    const inputType = request.inputType === "query" ? "query" : "document";

    const body: Record<string, unknown> = {
      input: request.texts,
      model: this.model,
      input_type: inputType,
    };

    if (this.dims) {
      body.output_dimension = this.dims;
    }

    const { data } = await fetchJson(
      `${this.baseUrl}/v1/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      },
      this.retry,
      this.fetcher
    );

    const payload = data as VoyageResponse;
    const vectors = payload.data.map((entry) => entry.embedding);

    return {
      vectors,
      dimensions: vectors[0]?.length ?? this.dims ?? 0,
      provider: "voyage",
      model: this.model,
      tokensUsed: payload.usage?.total_tokens,
    };
  }

  async embedDocumentChunksContextual(chunks: string[]): Promise<EmbedResponse> {
    return this.embedContextual([chunks], "document");
  }

  private async embedContextual(
    inputs: string[][],
    inputType: "query" | "document"
  ): Promise<EmbedResponse> {
    const body: Record<string, unknown> = {
      inputs,
      model: this.model,
      input_type: inputType,
    };

    if (this.dims) {
      body.output_dimension = this.dims;
    }

    const { data } = await fetchJson(
      `${this.baseUrl}/v1/contextualizedembeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      },
      this.retry,
      this.fetcher
    );

    const payload = data as VoyageContextualResponse;
    let vectors: number[][] = [];

    if (payload.results && payload.results.length > 0) {
      vectors = payload.results[0]?.embeddings ?? [];
    } else if (payload.data && payload.data.length > 0) {
      const lists = [...payload.data].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0)
      );
      for (const list of lists) {
        const entries = [...(list.data ?? [])].sort(
          (a, b) => (a.index ?? 0) - (b.index ?? 0)
        );
        for (const entry of entries) {
          if (entry.embedding) vectors.push(entry.embedding);
        }
      }
    }

    return {
      vectors,
      dimensions: vectors[0]?.length ?? this.dims ?? 0,
      provider: "voyage",
      model: this.model,
      tokensUsed: payload.usage?.total_tokens,
    };
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const start = Date.now();
    try {
      await this.embed({ texts: ["ping"], inputType: "query" });
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, latencyMs: Date.now() - start, detail: message };
    }
  }
}
