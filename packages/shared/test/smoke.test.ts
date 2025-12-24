import { describe, it, expect } from "vitest";
import { ToolSchemas } from "../src";

describe("shared schemas", () => {
  it("exposes the memory.commit schema", () => {
    expect(ToolSchemas["memory.commit"]).toBeDefined();
  });
});
