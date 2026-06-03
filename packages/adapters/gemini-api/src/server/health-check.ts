/** Per-model health check: POST a minimal prompt to the Gemini REST API with a 5s timeout. */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

export type HealthCheckResult =
  | { ok: true }
  | { ok: false; status: number; body: string; quotaExhausted: boolean };

const QUOTA_RE =
  /429|QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|capacity on this model|quota will reset|too many requests|rate[-\s]?limit/i;

export async function checkGeminiModelHealth(
  model: string,
  apiKey: string,
): Promise<HealthCheckResult> {
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: { maxOutputTokens: 1 },
  });

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: msg, quotaExhausted: false };
  }

  if (response.ok) return { ok: true };

  let responseBody = "";
  try {
    responseBody = await response.text();
  } catch {
    // ignore body read failure
  }
  const quotaExhausted = response.status === 429 || QUOTA_RE.test(responseBody);
  return { ok: false, status: response.status, body: responseBody, quotaExhausted };
}
