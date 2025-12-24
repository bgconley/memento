import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildOutlineFromChunks, chunkMarkdown } from "../../src/chunking";

const fixturePath = path.join(__dirname, "../fixtures/outline/sample.md");

function toOutline(markdown: string) {
  const chunks = chunkMarkdown(markdown);
  return buildOutlineFromChunks(
    chunks.map((chunk) => ({
      section_anchor: chunk.section_anchor,
      heading_path: chunk.heading_path,
      start_char: chunk.start_char,
      end_char: chunk.end_char,
    }))
  );
}

describe("outline builder", () => {
  it("returns stable anchors and heading paths", () => {
    const markdown = fs.readFileSync(fixturePath, "utf8");
    const outline = toOutline(markdown);

    const anchors = outline.map((section) => section.section_anchor);
    expect(anchors).toEqual([
      "h1:overview",
      "h2:overview.setup",
      "h3:overview.setup.details",
      "h1:usage",
    ]);

    const paths = outline.map((section) => section.heading_path);
    expect(paths).toEqual([
      ["Overview"],
      ["Overview", "Setup"],
      ["Overview", "Setup", "Details"],
      ["Usage"],
    ]);

    for (const section of outline) {
      expect(section.start_char).not.toBeNull();
      expect(section.end_char).not.toBeNull();
      if (section.start_char !== null && section.end_char !== null) {
        expect(section.start_char).toBeLessThan(section.end_char);
      }
    }
  });
});
