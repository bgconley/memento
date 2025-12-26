import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closePool, getPool } from "@memento/core";
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

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server.shutdown", { signal });
    try {
      await server.close();
    } catch (err) {
      logger.error("server.close_failed", { err });
    }
    try {
      await closePool();
    } catch (err) {
      logger.error("pool.close_failed", { err });
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("server.start_failed", { err });
  process.exit(1);
});
