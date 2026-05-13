export interface ExchangeBootstrapTokenInput {
  paperclipPublicUrl: string;
  bootstrapToken: string;
}

interface ExchangeBootstrapTokenOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

function exponentialDelayMs(attemptIndex: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** attemptIndex, maxDelayMs);
}

export async function exchangeBootstrapToken(
  input: ExchangeBootstrapTokenInput,
  options: ExchangeBootstrapTokenOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetchImpl(`${input.paperclipPublicUrl}/api/agent-auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bootstrapToken: input.bootstrapToken }),
    });

    if (res.ok) {
      const body = (await res.json()) as { runJwt?: string };
      if (!body.runJwt) throw new Error("exchange response missing runJwt");
      return body.runJwt;
    }

    const responseText = await res.text();
    if (res.status === 429 && attempt < maxAttempts) {
      const retryAfterMs =
        parseRetryAfterMs(res.headers.get("retry-after")) ??
        exponentialDelayMs(attempt - 1, baseDelayMs, maxDelayMs);
      await sleep(retryAfterMs);
      continue;
    }

    const attempts = attempt === 1 ? "" : ` after ${attempt} attempts`;
    throw new Error(`bootstrap exchange failed${attempts} (${res.status}): ${responseText}`);
  }

  throw new Error("bootstrap exchange failed: retry attempts exhausted");
}
