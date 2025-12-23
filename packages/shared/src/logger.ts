export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function normalizeFields(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields) return {};
  const output: Record<string, unknown> = { ...fields };
  const err = output.err ?? output.error;
  if (err instanceof Error) {
    output.error_name = err.name;
    output.error_message = err.message;
    output.error_stack = err.stack;
    delete output.err;
    delete output.error;
  }
  return output;
}

export type Logger = {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  child: (fields: Record<string, unknown>) => Logger;
};

export function createLogger(baseFields: Record<string, unknown> = {}): Logger {
  const level = resolveLogLevel();
  const threshold = LEVEL_ORDER[level];
  const base = { pid: process.pid, ...baseFields };

  const log = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const entry = {
      level: lvl,
      time: new Date().toISOString(),
      message,
      ...base,
      ...normalizeFields(fields),
    };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  };

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}
