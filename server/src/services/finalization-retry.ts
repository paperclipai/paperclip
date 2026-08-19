const TERMINAL_CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08003",
  "08004",
  "08006",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "ECONNRESET",
  "EPIPE",
]);

export function isTerminalConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  let code: unknown;
  try {
    code = (error as { code?: unknown }).code;
  } catch {
    return false;
  }

  return typeof code === "string" && TERMINAL_CONNECTION_ERROR_CODES.has(code);
}

export async function persistFinalizationStepReliably<T>(
  write: () => Promise<T>,
  retryDelaysMs: readonly number[] = [25, 50],
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      lastError = error;
      if (isTerminalConnectionError(error)) {
        throw error;
      }
      const delayMs = retryDelaysMs[attempt];
      if (delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}
