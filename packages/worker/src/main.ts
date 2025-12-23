import { getPool } from "@memento/core";
import { createLogger } from "@memento/shared";
import { createJobHandlers, pollOutboxOnce } from "./outboxPoller";

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_METRICS_INTERVAL_MS = 30_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const logger = createLogger({ component: "worker" });
  const pool = getPool();
  const handlers = createJobHandlers();

  let running = true;
  let totalProcessed = 0;
  let totalErrors = 0;
  const startTime = Date.now();
  let lastMetrics = Date.now();
  const metricsInterval =
    Number(process.env.WORKER_METRICS_INTERVAL_MS ?? DEFAULT_METRICS_INTERVAL_MS) ||
    DEFAULT_METRICS_INTERVAL_MS;

  const shutdown = () => {
    running = false;
    logger.info("worker.shutdown");
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("worker.started", {
    poll_interval_ms: DEFAULT_INTERVAL_MS,
    batch_size: DEFAULT_BATCH_SIZE,
  });

  while (running) {
    try {
      const result = await pollOutboxOnce(pool, handlers, {
        batchSize: DEFAULT_BATCH_SIZE,
      });

      totalProcessed += result.processed;
      totalErrors += result.errors;

      if (result.processed > 0 || result.errors > 0) {
        logger.info("worker.poll", { processed: result.processed, errors: result.errors });
      }

      const now = Date.now();
      if (now - lastMetrics >= metricsInterval) {
        logger.info("worker.metrics", {
          processed_total: totalProcessed,
          error_total: totalErrors,
          uptime_ms: now - startTime,
        });
        lastMetrics = now;
      }

      if (result.processed === 0) {
        await sleep(DEFAULT_INTERVAL_MS);
      }
    } catch (err) {
      logger.error("worker.loop_error", { err });
      await sleep(DEFAULT_INTERVAL_MS);
    }
  }
}

main().catch((err) => {
  const logger = createLogger({ component: "worker" });
  logger.error("worker.start_failed", { err });
  process.exit(1);
});
