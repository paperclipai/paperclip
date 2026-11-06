import { CHAT_OPENCODE_MODEL } from "./chat-runtime-profile.js";
const healthId = "chat-setup-health.runner-opencode.local.setup-only";
const endpoint = "https://openrouter.ai/api/v1/key";
type Code = "recognized" | "auth-rejected" | "provider-unavailable" | "http-rejected" | "invalid-response" | "request-failed" | "prerequisite-missing";
export interface SetupCredentialReceipt {
  schema: "paperclip.setup-health-credential/v1"; code: Code; httpStatus: number | null;
  recognized: boolean; expired: boolean | null; budgetAvailable: boolean | null;
}
/** A single Node fetch outside Playwright request tracing; raw response/errors never leave this function. */
export async function checkSetupHealthCredential(input: {
  executionId: string; provider: string; model: string | undefined; credential: string | undefined;
  env: NodeJS.ProcessEnv; platform?: string; secrets: string[]; fetch?: typeof fetch; now?: number;
}): Promise<SetupCredentialReceipt> {
  const receipt: SetupCredentialReceipt = { schema: "paperclip.setup-health-credential/v1", code: "prerequisite-missing", httpStatus: null, recognized: false, expired: null, budgetAvailable: null };
  if (input.executionId !== healthId || input.provider !== "opencode" || input.model !== CHAT_OPENCODE_MODEL
    || (input.platform ?? process.platform) !== "linux" || input.env.GITHUB_ACTIONS !== "true"
    || input.env.GITHUB_REPOSITORY !== "paperclipai/paperclip" || input.env.GITHUB_REF !== "refs/heads/master"
    || input.env.GITHUB_WORKFLOW_REF !== "paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master"
    || !input.credential?.trim()) return receipt;
  // The normal tracked sink durably registers this before fetch or evidence writes.
  if (!input.secrets.includes(input.credential)) input.secrets.push(input.credential);
  try {
    const response = await (input.fetch ?? globalThis.fetch)(endpoint, { method: "GET", redirect: "error",
      headers: { Authorization: `Bearer ${input.credential}` }, signal: AbortSignal.timeout(8_000) });
    receipt.httpStatus = response.status;
    if (response.status !== 200) {
      await response.body?.cancel();
      receipt.code = [401, 403].includes(response.status) ? "auth-rejected" : response.status >= 500 ? "provider-unavailable" : "http-rejected";
      return receipt;
    }
    // Bound reads without persisting or reporting any bytes from the response.
    const reader = response.body?.getReader(); if (!reader) { receipt.code = "invalid-response"; return receipt; }
    let bytes = new Uint8Array();
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        if (bytes.length + chunk.value.length > 32_768) { await reader.cancel(); receipt.code = "invalid-response"; return receipt; }
        bytes = new Uint8Array([...bytes, ...chunk.value]);
      }
    } finally { reader.releaseLock(); }
    let body: any; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { receipt.code = "invalid-response"; return receipt; }
    const data = body?.data;
    const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value);
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.is_free_tier !== "boolean"
      || !amount(data.usage) || data.usage < 0 || !(data.limit === null || amount(data.limit))
      || !(data.limit_remaining === null || amount(data.limit_remaining))
      || !(data.expires_at === undefined || data.expires_at === null || typeof data.expires_at === "string" && Number.isFinite(Date.parse(data.expires_at)))) {
      receipt.code = "invalid-response"; return receipt;
    }
    receipt.recognized = true; receipt.code = "recognized";
    receipt.expired = data.expires_at == null ? data.expires_at === null ? false : null : Date.parse(data.expires_at) <= (input.now ?? Date.now());
    // This reports only the API's key limit, not unknown account balance/model access.
    receipt.budgetAvailable = amount(data.limit_remaining) ? data.limit_remaining > 0 : null;
    return receipt;
  } catch { receipt.code = "request-failed"; return receipt; }
}
