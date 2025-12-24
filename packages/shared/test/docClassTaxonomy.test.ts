import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocClassZ } from "../src/schemas";

function extractDocClassList(markdown: string): string[] {
  const start = markdown.indexOf("## Doc class list");
  if (start === -1) return [];
  const rest = markdown.slice(start);
  const end = rest.slice("## Doc class list".length).indexOf("## ");
  const section = end === -1 ? rest : rest.slice(0, "## Doc class list".length + end);

  const matches = Array.from(section.matchAll(/- `([a-z0-9_]+)`/g));
  return matches.map((match) => match[1]);
}

describe("doc_class taxonomy", () => {
  it("doc_class values in docs are valid", () => {
    const filePath = path.resolve(__dirname, "..", "..", "..", "docs", "doc-class-taxonomy.md");
    const markdown = fs.readFileSync(filePath, "utf-8");
    const values = extractDocClassList(markdown);

    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(() => DocClassZ.parse(value)).not.toThrow();
    }
  });
});
