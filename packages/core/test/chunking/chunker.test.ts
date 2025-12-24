import { describe, expect, it } from "vitest";
import { buildSectionAnchor, chunkMarkdown } from "../../src/chunking";

const SAMPLE = [
  "# MyApp",
  "",
  "Intro paragraph.",
  "",
  "## Auth",
  "",
  "Details about auth.",
  "",
  "```",
  "yaml",
  "key: value",
  "```",
  "",
  "More details.",
  "",
  "## API",
  "",
  "- Item one",
  "- Item two",
  "",
].join("\n");

describe("chunkMarkdown", () => {
  it("builds stable anchors", () => {
    expect(buildSectionAnchor(["MyApp"]).startsWith("h1:")).toBe(true);
    expect(buildSectionAnchor(["MyApp", "Auth"])).toBe("h2:myapp.auth");
  });

  it("does not split code fences and preserves offsets", () => {
    const chunks = chunkMarkdown(SAMPLE, { targetTokens: 5, maxTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);

    const codeChunk = chunks.find((chunk) => chunk.chunk_text.includes("key: value"));
    expect(codeChunk).toBeTruthy();
    expect(codeChunk?.chunk_text.includes("```")).toBe(true);

    const chunk = chunks[0];
    const slice = SAMPLE.slice(chunk.start_char, chunk.end_char);
    expect(chunk.chunk_text).toBe(slice);
  });
});
