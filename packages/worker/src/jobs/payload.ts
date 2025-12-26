export function parsePayload(payload: unknown): Record<string, unknown> {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch (err) {
      throw new Error("Outbox payload is not valid JSON");
    }
  }
  if (payload && typeof payload === "object") {
    return payload as Record<string, unknown>;
  }
  return {};
}

export function requireStringField(
  payload: Record<string, unknown>,
  field: string,
  errorPrefix: string
): string {
  const value = payload[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`${errorPrefix} missing ${field}`);
}
