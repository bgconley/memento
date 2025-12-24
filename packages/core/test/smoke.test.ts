import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("core fixtures", () => {
  it("ships tool fixtures for golden tests", () => {
    const fixturesDir = path.resolve("test/fixtures/tools");
    const entries = fs.readdirSync(fixturesDir);
    expect(entries.length).toBeGreaterThan(0);
  });
});
