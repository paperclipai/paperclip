import type { HireApprovedPayload, HireApprovedHookResult } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

const HIRE_CALLBACK_TIMEOUT_MS = 10_000;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * OpenClaw adapter lifecycle hook: when an agent is approved/hired, POST the payload to a
 * configured callback URL so the cloud operator can notify the user (e.g. "you're hired").
 * Best-effort; failures are non-fatal to the approval flow.
 */
export async function onHireApproved(
  payload: HireApprovedPayload,
  adapterConfig: Record<string, unknown>,
): Promise<HireApprovedHookResult> {
  const config = parseObject(adapterConfig);
  const url = nonEmpty(config.hireApprovedCallbackUrl);
  if (!url) {
    return { ok: true };
  }

  const method = (asString(config.hireApprovedCallbackMethod, "POST").trim().toUpperCase()) || "POST";
  const authHeader = nonEmpty(config.hireApprovedCallbackAuthHeader) ?? nonEmpty(config.webhookAuthHeader);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (authHeader && !headers.authorization && !headers.Authorization) {
    headers.Authorization = authHeader;
  }
  const extraHeaders = parseObject(config.hireApprovedCallbackHeaders) as Record<string, unknown>;
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (typeof value === "string" && value.trim().length > 0) {
      headers[key] = value;
    }
  }

  const body = JSON.stringify({
    ...payload,
    event: "hire_approved",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HIRE_CALLBACK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${response.status} ${response.statusText}`,
        detail: { status: response.status, statusText: response.statusText, body: text.slice(0, 500) },
      };
    }
    return { ok: true };
  } catch (err) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error ? err.cause : undefined;
    return {
      ok: false,
      error: message,
      detail: cause != null ? { cause: String(cause) } : undefined,
    };
  }
}
