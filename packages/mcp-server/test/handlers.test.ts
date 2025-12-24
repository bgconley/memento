import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createHandlers } from "../src/handlers";
import { createRequestContext } from "../src/context";
import { McpError } from "@modelcontextprotocol/sdk/types";

const handlers = createHandlers({
  pool: {} as Pool,
  context: createRequestContext(),
});

describe("handler stubs", () => {
  it("returns a consistent not implemented error", async () => {
    await expect(handlers.projectsList({})).rejects.toBeInstanceOf(McpError);
  });
});
