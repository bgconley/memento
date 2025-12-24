import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/chunking";

const FIXTURES_DIR = path.resolve(__dirname, "fixtures", "chunking");
const GOLDENS_DIR = path.resolve(__dirname, "golden", "chunking");
const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === "1";

type ChunkSnapshot = {
  chunk_index: number;
  heading_path: string[];
  section_anchor: string;
  start_char: number;
  end_char: number;
  sha256: string;
  excerpt: string;
};

type FixtureSnapshot = {
  fixture: string;
  config: {
    targetTokens: number;
    maxTokens: number;
    overlapTokens: number;
  };
  chunks: ChunkSnapshot[];
};

const CONFIG = { targetTokens: 40, maxTokens: 80, overlapTokens: 0 };

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function buildExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

function buildSnapshot(fixtureName: string, markdown: string): FixtureSnapshot {
  const chunks = chunkMarkdown(markdown, CONFIG).map((chunk) => ({
    chunk_index: chunk.chunk_index,
    heading_path: chunk.heading_path,
    section_anchor: chunk.section_anchor,
    start_char: chunk.start_char,
    end_char: chunk.end_char,
    sha256: hashText(chunk.chunk_text),
    excerpt: buildExcerpt(chunk.chunk_text),
  }));

  return {
    fixture: fixtureName,
    config: CONFIG,
    chunks,
  };
}

function readGolden(filePath: string): FixtureSnapshot {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as FixtureSnapshot;
}

describe("chunking golden snapshots", () => {
  const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort();

  for (const fixture of fixtures) {
    it(`matches golden snapshot for ${fixture}`, () => {
      const markdown = fs.readFileSync(path.join(FIXTURES_DIR, fixture), "utf-8");
      const snapshot = buildSnapshot(fixture, markdown);
      const goldenPath = path.join(GOLDENS_DIR, fixture.replace(/\.md$/, ".json"));

      if (UPDATE_GOLDENS) {
        fs.mkdirSync(GOLDENS_DIR, { recursive: true });
        fs.writeFileSync(goldenPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
        return;
      }

      const expected = readGolden(goldenPath);
      expect(snapshot).toEqual(expected);
    });

    it(`preserves slice offsets for ${fixture}`, () => {
      const markdown = fs.readFileSync(path.join(FIXTURES_DIR, fixture), "utf-8");
      const chunks = chunkMarkdown(markdown, CONFIG);
      for (const chunk of chunks) {
        expect(chunk.chunk_text).toEqual(markdown.slice(chunk.start_char, chunk.end_char));
      }
    });
  }

  it("splits oversized blocks to honor maxTokens", () => {
    const markdown = "A".repeat(2000);
    const config = { targetTokens: 50, maxTokens: 80, overlapTokens: 0 };
    const chunks = chunkMarkdown(markdown, config);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.chunk_text.length).toBeLessThanOrEqual(config.maxTokens * 4);
      expect(chunk.chunk_text).toEqual(markdown.slice(chunk.start_char, chunk.end_char));
    }
  });
});
