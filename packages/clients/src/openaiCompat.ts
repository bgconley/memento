import {
  DEFAULT_RETRY_OPTIONS,
  Embedder,
  EmbedRequest,
  EmbedResponse,
  EmbedderConfigBase,
  fetchJson,
  normalizeBaseUrl,
} from "./embedder";

export type OpenAICompatConfig = EmbedderConfigBase;

type OpenAICompatEmbedding = { embedding: number[] };

type OpenAICompatResponse = {
  data: OpenAICompatEmbedding[];
  usage?: { total_tokens?: number };
};

export class OpenAICompatEmbedder implements Embedder {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly dims?: number;
  private readonly retry;
  private readonly fetcher;

  constructor(config: OpenAICompatConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dims = config.dims;
    this.retry = config.retry ?? DEFAULT_RETRY_OPTIONS;
    this.fetcher = config.fetcher;
  }

  static fromEnv(): OpenAICompatEmbedder {
    const baseUrl = process.env.OPENAI_COMPAT_BASE_URL ?? "http://localhost:8080/v1";
    const apiKey = process.env.OPENAI_COMPAT_API_KEY;
    const model = process.env.OPENAI_COMPAT_MODEL ?? "local-embed";
    const dims = process.env.OPENAI_COMPAT_DIMS
      ? Number(process.env.OPENAI_COMPAT_DIMS)
      : undefined;

    return new OpenAICompatEmbedder({ baseUrl, apiKey, model, dims });
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const body: Record<string, unknown> = {
      input: request.texts,
      model: this.model,
    };

    if (this.dims) {
      body.dimensions = this.dims;
    }

    const { data } = await fetchJson(
      `${this.baseUrl}/embeddings`,
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

    const payload = data as OpenAICompatResponse;
    const vectors = payload.data.map((entry) => entry.embedding);

    return {
      vectors,
      dimensions: vectors[0]?.length ?? this.dims ?? 0,
      provider: "openai_compat",
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
