import fs from "node:fs";
import path from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HASH_RE = /^[0-9a-f]{40,64}$/i;

export function loadJson<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export function resolveFixturePath(...parts: string[]): string {
  return path.resolve(__dirname, "..", "..", "..", "core", "test", "fixtures", "tools", ...parts);
}

export function resolveGoldenPath(...parts: string[]): string {
  return path.resolve(__dirname, "..", "..", "..", "core", "test", "golden", "tools", ...parts);
}

export function normalizeOutput<T>(value: T): T {
  return normalizeValue(value, null) as T;
}

function normalizeValue(value: unknown, key: string | null): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, null));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      result[entryKey] = normalizeValue(entryValue, entryKey);
    }
    return result;
  }

  if (typeof value === "string") {
    return normalizeString(value, key);
  }

  return value;
}

function normalizeString(value: string, key: string | null): string {
  if (key === "resource_uri") {
    return normalizeResourceUri(value);
  }

  if (key === "bundle_summary" || key === "excerpt") {
    return "<string>";
  }

  if (key === "project_key" && HASH_RE.test(value)) {
    return "<sha256:project_key>";
  }

  if (UUID_RE.test(value)) {
    return `<uuid:${key ?? "uuid"}>`;
  }

  if (ISO_RE.test(value)) {
    return `<iso:${key ?? "timestamp"}>`;
  }

  return value;
}

function normalizeResourceUri(value: string): string {
  const match = /^memory:\/\/projects\/([^/]+)\/items\/([^@#]+)(@[^#]+)?(#.+)?$/.exec(value);
  if (!match) return value;

  const suffix = `${match[3] ?? ""}${match[4] ?? ""}`;
  return `memory://projects/<uuid:project_id>/items/<uuid:item_id>${suffix}`;
}
