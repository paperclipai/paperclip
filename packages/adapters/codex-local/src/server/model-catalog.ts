import type { AdapterModel } from "@paperclipai/adapter-utils";

/**
 * The model catalog the Codex CLI itself shows for a ChatGPT sign-in.
 *
 * Codex reads `GET {CHATGPT_CODEX_BASE_URL}/models?client_version=<cli version>`
 * with the account's bearer token (openai/codex `codex-api/src/endpoint/models.rs`)
 * and caches the answer in `$CODEX_HOME/models_cache.json`. The answer depends on
 * the account (plans differ) and on the client version: the backend lists a model
 * only to a client version that can run it, so the same account sees
 * `gpt-6.1-sol` at 0.159.0 and not at 0.158.0.
 */
export const CODEX_MODEL_CATALOG_URL = "https://chatgpt.com/backend-api/codex/models";

// Send the same originator and User-Agent as the Codex CLI. The catalog is
// requested on behalf of the installed CLI, at its version, so the request
// identifies as that client.
const CODEX_ORIGINATOR = "codex_cli_rs";
// The Codex CLI's own timeout for this request (`models_endpoint.rs`).
const CATALOG_TIMEOUT_MS = 5_000;
// The full answer carries per-model instructions and is a few hundred KB.
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const STABLE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

type CatalogEntry = {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  priority?: unknown;
};

/**
 * Models the account offers in the Codex model picker, in the backend's order.
 * Hidden entries (`visibility: "hide"`, such as internal review models) are
 * dropped. Throws `chatgpt codex models api returned <status>` on an HTTP
 * failure, so a caller can recognise a 401 and refresh the token.
 */
export async function fetchCodexModelCatalog(input: {
  accessToken: string;
  accountId: string | null;
  clientVersion: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<AdapterModel[]> {
  if (!STABLE_VERSION.test(input.clientVersion)) {
    throw new Error("Codex model catalog requires a stable Codex CLI version");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.accessToken}`,
    originator: CODEX_ORIGINATOR,
    "User-Agent": `${CODEX_ORIGINATOR}/${input.clientVersion}`,
  };
  if (input.accountId) headers["ChatGPT-Account-Id"] = input.accountId;
  const url = `${CODEX_MODEL_CATALOG_URL}?client_version=${encodeURIComponent(input.clientVersion)}`;
  // One deadline covers the headers and the body, so a stalled body cannot
  // hold the model picker past the timeout.
  const deadline = AbortSignal.timeout(input.timeoutMs ?? CATALOG_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const response = await fetch(url, { headers, redirect: "error", signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`chatgpt codex models api returned ${response.status}`);
  }
  return parseCodexModelCatalog(JSON.parse(await readBoundedText(response, MAX_CATALOG_BYTES)));
}

/** Read at most `maxBytes` of the body; cancel and fail once it is exceeded. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("chatgpt codex models api answer is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("chatgpt codex models api answer is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

/** Keep listed models with a plain slug, ordered by `priority`, then slug. */
export function parseCodexModelCatalog(body: unknown): AdapterModel[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) throw new Error("chatgpt codex models api answer has no model list");
  const seen = new Set<string>();
  return models
    .filter((entry): entry is CatalogEntry => Boolean(entry) && typeof entry === "object")
    .filter((entry) => entry.visibility === "list" && typeof entry.slug === "string" && MODEL_SLUG.test(entry.slug))
    .map((entry) => ({
      id: entry.slug as string,
      label: typeof entry.display_name === "string" && entry.display_name.trim() && entry.display_name.length <= 80
        ? entry.display_name.trim()
        : (entry.slug as string),
      priority: typeof entry.priority === "number" && Number.isFinite(entry.priority) ? entry.priority : Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .filter((model) => (seen.has(model.id) ? false : (seen.add(model.id), true)))
    .map(({ id, label }) => ({ id, label }));
}
