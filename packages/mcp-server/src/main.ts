import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { getPool } from "@memento/core";
import { createLogger } from "@memento/shared";
import { registerTools } from "./registerTools";
import { registerPrompts } from "./prompts";
import { createHandlers } from "./handlers";
import { createRequestContext } from "./context";
import { registerResources } from "./resources";

const logger = createLogger({ component: "mcp-server" });

async function main() {
  const server = new McpServer({
    name: "memento",
    version: "0.0.0",
  });

  const pool = getPool();
  const context = createRequestContext();
  const handlers = createHandlers({ pool, context });

  registerTools(server, handlers);
  registerPrompts(server);
  registerResources(server, { pool, context });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("server.started", { version: "0.0.0" });
}

main().catch((err) => {
  logger.error("server.start_failed", { err });
  process.exit(1);
});
