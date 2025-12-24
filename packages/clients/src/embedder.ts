import crypto from "node:crypto";

export type EmbedInputType = "query" | "passage";

export type EmbedRequest = {
  texts: string[];
  inputType: EmbedInputType;
};

export type EmbedResponse = {
  vectors: number[][];
  dimensions: number;
  provider: string;
  model: string;
  tokensUsed?: number;
};

export type RetryOptions = {
  retries: number;
  minDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  retries: 2,
  minDelayMs: 200,
  maxDelayMs: 2000,
};

export type Fetcher = typeof fetch;

export type EmbedderConfigBase = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  dims?: number;
  retry?: RetryOptions;
  fetcher?: Fetcher;
};

export interface Embedder {
  embed(request: EmbedRequest): Promise<EmbedResponse>;
  embedDocumentChunksContextual?(chunks: string[]): Promise<EmbedResponse>;
  health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  options?: RetryOptions,
  fetcher?: Fetcher
): Promise<{ data: unknown; response: Response }>{
  const retry = options ?? DEFAULT_RETRY_OPTIONS;
  const fetchImpl = fetcher ?? fetch;

  let attempt = 0;
  let delay = retry.minDelayMs;

  while (true) {
    try {
      const response = await fetchImpl(url, init);
      if (!response.ok) {
        if (shouldRetry(response.status, attempt, retry.retries)) {
          await sleep(delay);
          delay = Math.min(delay * 2, retry.maxDelayMs);
          attempt += 1;
          continue;
        }
        const errorText = await response.text();
        throw new Error(`Embedder request failed (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as unknown;
      return { data, response };
    } catch (err) {
      if (attempt >= retry.retries) {
        throw err;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, retry.maxDelayMs);
      attempt += 1;
    }
  }
}

function shouldRetry(status: number, attempt: number, retries: number): boolean {
  if (attempt >= retries) return false;
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FakeEmbedderConfig = {
  dims?: number;
  model?: string;
  provider?: string;
};

export class FakeEmbedder implements Embedder {
  private readonly dims: number;
  private readonly model: string;
  private readonly provider: string;

  constructor(config: FakeEmbedderConfig = {}) {
    this.dims = config.dims ?? 8;
    this.model = config.model ?? "fake-embedder";
    this.provider = config.provider ?? "fake";
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const vectors = request.texts.map((text) => deterministicVector(text, this.dims));
    return {
      vectors,
      dimensions: this.dims,
      provider: this.provider,
      model: this.model,
    };
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    return { ok: true, latencyMs: 0 };
  }
}

function deterministicVector(text: string, dims: number): number[] {
  const normalized = text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .sort()
    .join(" ");
  const hash = crypto.createHash("sha256").update(normalized).digest();
  const vector: number[] = [];
  for (let i = 0; i < dims; i += 1) {
    const value = hash[i % hash.length] / 127.5 - 1;
    vector.push(Number(value.toFixed(6)));
  }
  return vector;
}
