import { FakeEmbedder, type Embedder } from "./embedder";
import { JinaEmbedder } from "./jina";
import { OpenAICompatEmbedder } from "./openaiCompat";
import { VoyageEmbedder } from "./voyage";

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string }> = {
  voyage: { baseUrl: "https://api.voyageai.com" },
  jina: { baseUrl: "https://api.jina.ai" },
  openai_compat: { baseUrl: "http://localhost:8080/v1" },
};

export type EmbeddingProfileLike = {
  provider: string;
  model: string;
  dims: number;
  provider_config?: Record<string, unknown> | null;
};

function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.toLowerCase() === "true" || value === "1";
  }
  return false;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveBaseUrl(provider: string, config: Record<string, unknown>): string {
  const fromConfig = readString(config.base_url);
  const fromEnv = readString(process.env.EMBEDDER_BASE_URL);
  return fromConfig ?? fromEnv ?? PROVIDER_DEFAULTS[provider]?.baseUrl ?? "";
}

function resolveApiKey(config: Record<string, unknown>): string | undefined {
  const fromEnv = readString(process.env.EMBEDDER_API_KEY);
  const fromConfig = readString(config.api_key);
  return fromEnv ?? fromConfig;
}

export function createEmbedderFromProfile(profile: EmbeddingProfileLike): Embedder {
  const config = profile.provider_config ?? {};

  if (readBoolean(process.env.EMBEDDER_USE_FAKE) || readBoolean(config.use_fake)) {
    return new FakeEmbedder({ dims: profile.dims, model: profile.model, provider: profile.provider });
  }

  const baseUrl = resolveBaseUrl(profile.provider, config);
  const apiKey = resolveApiKey(config);

  if (!baseUrl) {
    throw new Error(`Embedder base_url missing for provider ${profile.provider}`);
  }

  if (profile.provider === "voyage") {
    return new VoyageEmbedder({ baseUrl, apiKey, model: profile.model, dims: profile.dims });
  }

  if (profile.provider === "jina") {
    const lateChunking = readBoolean(config.late_chunking);
    return new JinaEmbedder({
      baseUrl,
      apiKey,
      model: profile.model,
      dims: profile.dims,
      lateChunking,
    });
  }

  if (profile.provider === "openai_compat") {
    return new OpenAICompatEmbedder({ baseUrl, apiKey, model: profile.model, dims: profile.dims });
  }

  throw new Error(`Unsupported embedder provider: ${profile.provider}`);
}
