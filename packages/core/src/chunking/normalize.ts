export type NormalizeInput = {
  format: string;
  text: string;
  json?: Record<string, unknown> | null;
};

export function normalizeMarkdown(input: NormalizeInput): string {
  if (input.format === "json" && input.json && input.text.trim().length === 0) {
    return JSON.stringify(input.json, null, 2);
  }

  return input.text;
}
