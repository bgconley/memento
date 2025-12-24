import {
  DEFAULT_RETRY_OPTIONS,
  Embedder,
  EmbedRequest,
  EmbedResponse,
  EmbedderConfigBase,
  fetchJson,
  normalizeBaseUrl,
} from "./embedder";

export type JinaConfig = EmbedderConfigBase & { lateChunking?: boolean };

type JinaEmbedding = { embedding: number[] };

type JinaResponse = {
  data: JinaEmbedding[];
  usage?: { total_tokens?: number };
};

export class JinaEmbedder implements Embedder {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly dims?: number;
  private readonly lateChunking: boolean;
  private readonly retry;
  private readonly fetcher;

  constructor(config: JinaConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dims = config.dims;
    this.lateChunking = config.lateChunking ?? false;
    this.retry = config.retry ?? DEFAULT_RETRY_OPTIONS;
    this.fetcher = config.fetcher;
  }

  static fromEnv(): JinaEmbedder {
    const baseUrl = process.env.JINA_BASE_URL ?? "https://api.jina.ai";
    const apiKey = process.env.JINA_API_KEY;
    const model = process.env.JINA_MODEL ?? "jina-embeddings-v3";
    const dims = process.env.JINA_DIMS ? Number(process.env.JINA_DIMS) : undefined;

    return new JinaEmbedder({ baseUrl, apiKey, model, dims });
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const task = request.inputType === "query" ? "retrieval.query" : "retrieval.passage";

    const body: Record<string, unknown> = {
      input: request.texts,
      model: this.model,
      task,
    };

    if (this.dims) {
      body.dimensions = this.dims;
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

    const payload = data as JinaResponse;
    const vectors = payload.data.map((entry) => entry.embedding);

    return {
      vectors,
      dimensions: vectors[0]?.length ?? this.dims ?? 0,
      provider: "jina",
      model: this.model,
      tokensUsed: payload.usage?.total_tokens,
    };
  }

  async embedDocumentChunksContextual(chunks: string[]): Promise<EmbedResponse> {
    const body: Record<string, unknown> = {
      input: chunks,
      model: this.model,
      task: "retrieval.passage",
      late_chunking: this.lateChunking,
    };

    if (this.dims) {
      body.dimensions = this.dims;
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

    const payload = data as JinaResponse;
    const vectors = payload.data.map((entry) => entry.embedding);

    return {
      vectors,
      dimensions: vectors[0]?.length ?? this.dims ?? 0,
      provider: "jina",
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
